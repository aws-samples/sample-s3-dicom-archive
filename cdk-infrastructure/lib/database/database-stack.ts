// PHI/HIPAA: this Aurora cluster holds the PHI-bearing DICOM/HL7 index (patient
// IDs, names, accession numbers, study metadata). Encryption at rest + in
// transit and access control are operator responsibilities — see PHI-HANDLING.md
// at the repo root.
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { appSubnets, dbSubnets } from '../common/app-subnets';
export interface DatabaseStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  vpc: ec2.IVpc;
  adminEmail: string;
  /** Deployment environment (e.g. 'dev', 'test', 'prod'). Controls DB
   *  deletion protection + removal policy; anything other than dev/test is
   *  treated as a protected (prod/PHI) environment. */
  environment?: string;
  /** Shared Lambda layer (mysql2 + the DB helpers) for schema-init and the
   *  rotation function, which talk MySQL directly (no Data API). */
  sharedLayer: lambda.ILayerVersion;
}

export class DatabaseStack extends cdk.NestedStack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly proxy: rds.DatabaseProxy;
  public readonly proxyEndpoint: string;
  public readonly secret: secretsmanager.ISecret;
  public readonly clusterArn: string;
  public readonly secretArn: string;
  /** Dedicated read-only DB user secret for the analytics Lambdas (SELECT on a
   *  fixed table allowlist only). Separate from the master secret so the
   *  analytics path can never write or read outside its grants. */
  public readonly analyticsRoSecret: secretsmanager.Secret;
  public readonly analyticsRoSecretArn: string;
  /** Read-only DB user for virtual-folder analytics: SELECT on the vf_<id>
   *  databases only (wildcard grant), no shared table. Storage analytics use
   *  analyticsRoSecret, which has no vf_<id> grant. Splitting the two means a
   *  VF-scoped query cannot read the raw shared tree and a storage query cannot
   *  read any folder's tree, even if the SQL guard were wrong (EdgeSwarm D-2). */
  public readonly analyticsVfRoSecret: secretsmanager.Secret;
  /** EdgeSwarm F-7 least-privilege users. Every runtime component connects as
   *  one of these; the master secret is used only by schema-init.
   *  app_rw:       DML + schema-evolution DDL on the app DB and vf_<id> DBs.
   *  authz_ro:     SELECT users/privilege_groups, UPDATE users.last_login.
   *  audit_writer: SELECT/INSERT audit_logs (append-only). */
  public readonly appSecret: secretsmanager.Secret;
  public readonly authzSecret: secretsmanager.Secret;
  public readonly auditSecret: secretsmanager.Secret;
  public readonly databaseName: string;
  public readonly vpc: ec2.IVpc;
  public readonly dbSecurityGroup: ec2.ISecurityGroup;
  // One shared client SG for ALL lambdas that reach Aurora via the RDS Proxy.
  // Consolidates the former ~20 per-stack *DbClientSg groups (each of which added
  // its own identical 3306 ingress rule to dbSecurityGroup) into ONE group and
  // ONE ingress rule — well under the ~60-rule-per-SG quota the per-stack sprawl
  // was consuming. Consuming stacks attach this to their lambdas instead of
  // creating their own. NOT for ECS task SGs (dicom-service / dicomweb / nifti),
  // which carry additional ALB/NLB ingress and must keep their own SG.
  public readonly lambdaToRdsSg: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const { stackPrefix } = props;
    this.databaseName = 'dicomarchive';

    // Treat anything other than an explicit dev/test env as a protected
    // (prod/PHI) environment: encryption is always on; a protected env also
    // gets deletion protection and RETAIN so the PHI index cannot be destroyed
    // by a stack teardown. A dev/test env stays destroyable for fast iteration.
    const env = (props.environment || 'dev').toLowerCase();
    const isProtectedEnv = env !== 'dev' && env !== 'test';

    // Aurora MySQL 8.4 (compatible with community MySQL 8.4 LTS). Aurora MySQL
    // 3.08/3.09 reached end of standard support on 2026-08-31.
    const engine = rds.DatabaseClusterEngine.auroraMysql({
      version: rds.AuroraMysqlEngineVersion.of('8.4.mysql_aurora.8.4.8', '8.4'),
    });

    // 8.4 replaced default_authentication_plugin with the instance-level
    // authentication_policy, which defaults to caching_sha2_password. The RDS
    // Proxy below is pinned to MYSQL_NATIVE_PASSWORD and every DB user is
    // created WITH mysql_native_password, so keep that as the default: the
    // master user is created with the plugin this parameter names when the
    // cluster is created, and the rotation lambda's password resets use it too.
    const writerParams = new rds.ParameterGroup(this, 'WriterParameterGroup', {
      engine,
      description: `${stackPrefix} Aurora MySQL 8.4 writer parameters`,
      parameters: { authentication_policy: '*:mysql_native_password' },
    });

    // Create Aurora Serverless v2 cluster
    this.cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine,
      vpc: props.vpc,
      vpcSubnets: dbSubnets(props.vpc),
      writer: rds.ClusterInstance.serverlessV2('writer', { parameterGroup: writerParams }),
      serverlessV2MinCapacity: 8,
      serverlessV2MaxCapacity: 32,
      defaultDatabaseName: this.databaseName,
      // Encrypt the PHI index at rest (default aws/rds KMS key). Always on.
      storageEncrypted: true,
      // Protect prod/PHI data: block accidental deletion and retain on removal.
      deletionProtection: isProtectedEnv,
      removalPolicy: isProtectedEnv ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      // Point-in-time recovery window (F-7): 35 days (the maximum) for a
      // protected environment, 7 for dev/test.
      backup: { retention: cdk.Duration.days(isProtectedEnv ? 35 : 7) },
    });

    // RDS Data API OFF (EdgeSwarm F-7): it let any principal holding rds-data +
    // the master secret run SQL from outside the VPC. Everything now connects
    // in-VPC over MySQL (RDS Proxy, or the writer for schema-init/rotation).
    const cfnCluster = this.cluster.node.defaultChild as rds.CfnDBCluster;
    cfnCluster.enableHttpEndpoint = false;

    this.secret = this.cluster.secret!;
    this.clusterArn = this.cluster.clusterArn;
    this.secretArn = this.secret.secretArn;
    this.dbSecurityGroup = this.cluster.connections.securityGroups[0];

    // Shared client SG for every lambda that connects to Aurora via the proxy.
    // ONE ingress rule on dbSecurityGroup replaces the ~20 identical per-stack
    // rules. Created here (in the database stack, alongside dbSecurityGroup) and
    // threaded to consumers as a prop — same pattern as dbSecurityGroup — so
    // there is no cross-stack circular dependency.
    const lambdaToRdsSg = new ec2.SecurityGroup(this, 'LambdaToRdsSg', {
      vpc: this.cluster.vpc,
      securityGroupName: `${stackPrefix}-lambda-to-rds-sg`,
      description: `${stackPrefix} - shared Lambda to Aurora proxy (3306)`,
      allowAllOutbound: true,
    });
    lambdaToRdsSg.connections.allowTo(this.dbSecurityGroup, ec2.Port.tcp(3306),
      'shared lambda client SG to Aurora proxy');
    this.lambdaToRdsSg = lambdaToRdsSg;

    // Dedicated read-only secret for the analytics Lambdas. Same JSON shape the
    // RDS Data API expects (username/password/host/port/dbname/engine) so it can
    // be swapped in as DB_SECRET_ARN with no code change. The password is
    // generated here; the schema-init lambda creates the matching MySQL user
    // (mysql_native_password — the Proxy/Data-API auth plugin the master user
    // uses) and GRANTs it SELECT on the analytics table allowlist.
    this.analyticsRoSecret = new secretsmanager.Secret(this, 'AnalyticsRoSecret', {
      secretName: `${stackPrefix}/analytics-ro`,
      description: `[${stackPrefix}] Read-only DB user for analytics Lambdas (SELECT on allowlist only)`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'analytics_ro',
          engine: 'mysql',
          host: this.cluster.clusterEndpoint.hostname,
          port: this.cluster.clusterEndpoint.port,
          dbname: this.databaseName,
          dbClusterIdentifier: this.cluster.clusterIdentifier,
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });
    this.analyticsRoSecretArn = this.analyticsRoSecret.secretArn;

    this.analyticsVfRoSecret = new secretsmanager.Secret(this, 'AnalyticsVfRoSecret', {
      secretName: `${stackPrefix}/analytics-vf-ro`,
      description: `[${stackPrefix}] Read-only DB user for virtual-folder analytics (SELECT on vf_<id> databases only)`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'analytics_vf_ro',
          engine: 'mysql',
          host: this.cluster.clusterEndpoint.hostname,
          port: this.cluster.clusterEndpoint.port,
          dbname: this.databaseName,
          dbClusterIdentifier: this.cluster.clusterIdentifier,
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    const dbUserSecret = (id: string, username: string, description: string) =>
      new secretsmanager.Secret(this, id, {
        secretName: `${stackPrefix}/db-${username.replace(/_/g, '-')}`,
        description: `[${stackPrefix}] ${description}`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            username,
            engine: 'mysql',
            host: this.cluster.clusterEndpoint.hostname,
            port: this.cluster.clusterEndpoint.port,
            dbname: this.databaseName,
            dbClusterIdentifier: this.cluster.clusterIdentifier,
          }),
          generateStringKey: 'password',
          excludePunctuation: true,
          passwordLength: 32,
        },
      });
    this.appSecret = dbUserSecret('AppDbSecret', 'app_rw', 'App DB user: DML + schema DDL on the app and vf_<id> databases, no admin privileges');
    this.authzSecret = dbUserSecret('AuthzDbSecret', 'authz_ro', 'Authorizer/Cognito DB user: read users + privilege_groups, update last_login');
    this.auditSecret = dbUserSecret('AuditDbSecret', 'audit_writer', 'Audit DB user: insert into audit_logs only');

    // RDS Proxy — pools + multiplexes backend connections so the ingest fleet
    // (reserved concurrency up to 100+, one direct connection per warm Lambda)
    // stops churning Aurora connections. PyMySQL (text protocol, no server-side
    // prepared statements) means the Proxy does not pin the backend connection
    // per invocation, so multiplexing actually works. The ingest lambda's
    // DB_HOST points at this endpoint instead of the writer.
    this.proxy = new rds.DatabaseProxy(this, 'AuroraProxy', {
      proxyTarget: rds.ProxyTarget.fromCluster(this.cluster),
      // The proxy authenticates clients against EVERY registered secret. The
      // master secret backs the app/ingest users; the analytics-ro secret backs
      // the least-privilege 'analytics_ro' user the analytics SQL-query path
      // connects as (queryReadOnly -> DB_RO_SECRET_ARN). Without it here, an
      // analytics_ro connection through the proxy fails 1045 "Access denied ...
      // (using password: YES)" even though the DB user + password are correct,
      // because the proxy has no secret to match the incoming user.
      secrets: [this.secret, this.appSecret, this.authzSecret, this.auditSecret, this.analyticsRoSecret, this.analyticsVfRoSecret],
      vpc: this.cluster.vpc,
      vpcSubnets: dbSubnets(this.cluster.vpc),
      securityGroups: [this.dbSecurityGroup],
      requireTLS: true,
      // The proxy advertises this auth plugin to CLIENTS during the
      // client->proxy handshake. It MUST match the plugin the backend DB user
      // actually uses, or the proxy cannot complete the auth passthrough and
      // returns 1045 "Access denied ... (using password: YES)" on every
      // connection — regardless of TLS. Aurora MySQL 8 provisions the master
      // user ('admin', and every AWS_*_ACCESS app user here) with
      // mysql_native_password, NOT caching_sha2_password. The CDK default for a
      // MySQL proxy is MYSQL_CACHING_SHA2_PASSWORD, which is the mismatch that
      // broke the ingest lambda. Pin it to native_password to match the users.
      // Verified live: SELECT user, plugin FROM mysql.user -> admin =
      // mysql_native_password.
      clientPasswordAuthType: rds.ClientPasswordAuthType.MYSQL_NATIVE_PASSWORD,
      idleClientTimeout: cdk.Duration.minutes(30),
      maxConnectionsPercent: 90,
      maxIdleConnectionsPercent: 50,
    });
    // Proxy must be allowed to reach the cluster on 3306 (same SG here, so this
    // is a self-ingress rule).
    this.dbSecurityGroup.connections.allowFrom(this.proxy, ec2.Port.tcp(3306), 'RDS Proxy to Aurora');
    this.proxyEndpoint = this.proxy.endpoint;

    new cdk.CfnOutput(this, 'ProxyEndpoint', { value: this.proxyEndpoint });

    // Outputs (no exports in nested stacks)
    new cdk.CfnOutput(this, 'ClusterArn', {
      value: this.clusterArn,
    });

    new cdk.CfnOutput(this, 'SecretArn', {
      value: this.secretArn,
    });

    new cdk.CfnOutput(this, 'DatabaseName', {
      value: this.databaseName,
    });

    // Custom resource to initialize database schema
    // In-VPC (writer endpoint over MySQL/TLS, mysql2 from the shared layer).
    // PRIVATE_WITH_EGRESS for Secrets Manager + the CloudFormation response URL.
    const dbClientVpc = {
      vpc: this.cluster.vpc,
      vpcSubnets: appSubnets(this.cluster.vpc),
      securityGroups: [lambdaToRdsSg],
    };
    const userSecrets = [this.appSecret, this.authzSecret, this.auditSecret, this.analyticsRoSecret, this.analyticsVfRoSecret];
    const schemaInitFunction = new lambda.Function(this, 'SchemaInitFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/database-schema-init')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      layers: [props.sharedLayer],
      ...dbClientVpc,
    });
    schemaInitFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [this.secretArn, ...userSecrets.map(x => x.secretArn)],
    }));

    const schemaProvider = new cr.Provider(this, 'SchemaProvider', {
      onEventHandler: schemaInitFunction,
    });

    // Hash of all schema files so any SQL change re-runs the custom resource
    const schemaDir = path.join(__dirname, 'lambda/database-schema-init');
    const schemaFiles = fs.readdirSync(schemaDir).filter(f => f.endsWith('.sql')).sort();
    const schemaHash = crypto.createHash('sha256');
    for (const file of schemaFiles) {
      schemaHash.update(file);
      schemaHash.update(fs.readFileSync(path.join(schemaDir, file)));
    }

    const schemaInit = new cdk.CustomResource(this, 'SchemaInit', {
      serviceToken: schemaProvider.serviceToken,
      properties: {
        ClusterArn: this.clusterArn,
        SecretArn: this.secretArn,
        DatabaseName: this.databaseName,
        AdminEmail: props.adminEmail,
        VirtualFolderEnabled: 'true', // virtual folders are a core, always-on capability
        RoSecretArn: this.analyticsRoSecretArn,
        VfRoSecretArn: this.analyticsVfRoSecret.secretArn,
        AppSecretArn: this.appSecret.secretArn,
        AuthzSecretArn: this.authzSecret.secretArn,
        AuditSecretArn: this.auditSecret.secretArn,
        SchemaHash: schemaHash.digest('hex'),
        Version: '1.4.0', // Increment to force update (1.4.0: authz_ro SELECT on user_privilege_groups)
      },
    });

    // Ensure IAM policies are created before SchemaInit runs
    schemaInit.node.addDependency(this.cluster);
    schemaInit.node.addDependency(schemaInitFunction);
    schemaInit.node.addDependency(this.analyticsRoSecret);
    for (const sec of userSecrets) schemaInit.node.addDependency(sec);

    // Password rotation (F-7): every 30 days for the master user and every app
    // user, by ONE in-VPC function (single-user strategy: each user changes its
    // own password; alphanumeric only, which schema-init requires). Not rotated
    // at creation: the users only exist once schema-init has run. Clients
    // re-read the secret on an authentication failure (shared layer, auth
    // lambdas, DICOMweb container); Python lambdas read it on every connect.
    const rotationFn = new lambda.Function(this, 'DbSecretRotation', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/db-secret-rotation')),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      layers: [props.sharedLayer],
      description: `${stackPrefix} - rotates the DB user secrets (single-user)`,
      ...dbClientVpc,
    });
    for (const [i, sec] of [this.secret, ...userSecrets].entries()) {
      sec.addRotationSchedule(`Rotation${i}`, {
        rotationLambda: rotationFn,
        automaticallyAfter: cdk.Duration.days(30),
        rotateImmediatelyOnUpdate: false,
      });
    }
  }
}
