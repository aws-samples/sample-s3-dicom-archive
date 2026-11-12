import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as stepfunctionsTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';
import { createModuleRole } from '../common/module-role';
import { appSubnets } from '../common/app-subnets';
import { stateMachineObservability } from '../common/state-machine-observability';

export interface ExportStackProps extends cdk.NestedStackProps {
  customResourceRole?: iam.IRole;
  stackPrefix: string;
  dbClusterArn: string;
  dbSecretArn: string;
  dbName: string;
  // RDS Proxy migration (P2): connect via the proxy over mysql2, in-VPC.
  dbProxyEndpoint: string;
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  lambdaToRdsSg: ec2.ISecurityGroup;
  sharedLayer: lambda.ILayerVersion;
  processingJobsApiLambda: lambda.Function;
}

export class ExportStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: ExportStackProps) {
    super(scope, id, props);

    const exportBucket = new s3.Bucket(this, 'ExportBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    // Env for the proxy/mysql2 connect (shared layer's database.js reads these).
    // The parked Python export-worker also receives it but does not connect.
    const lambdaEnv = {
      DB_HOST: props.dbProxyEndpoint,
      DB_SECRET_ARN: props.dbSecretArn,
      DB_NAME: props.dbName,
      EXPORT_BUCKET: exportBucket.bucketName,
    };

    const secretsPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.dbSecretArn],
    });

    // One shared execution role for all export lambdas. Union: secret read +
    // exportBucket.grantPut (worker + csv). The rds-data grant was removed in the
    // proxy migration. Scoped to this module's own resources.
    const moduleRole = createModuleRole(this, 'ExportModuleRole', {
      description: 'Shared execution role for export module lambdas',
      vpc: true,
    });
    moduleRole.addToPolicy(secretsPolicy);
    exportBucket.grantPut(moduleRole);

    // Common VPC config for the Node DB lambdas (init/csv/complete). The Python
    // export-worker is parked and does not touch the DB, so it stays out of VPC.
    const dbVpcConfig = {
      vpc: props.vpc,
      vpcSubnets: appSubnets(props.vpc),
      securityGroups: [props.lambdaToRdsSg],
    };

    // Init Lambda
    const initLambda = new lambda.Function(this, 'ExportInit', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/export-init')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      layers: [props.sharedLayer],
      environment: lambdaEnv,
      role: moduleRole,
      ...dbVpcConfig,
    });

    // Worker Lambda (Python with pydicom for de-identification)
    const workerLambda = new lambda.Function(this, 'ExportWorker', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'lambda_function.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/export-worker'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          command: ['bash', '-c', 'export HOME=/tmp && export XDG_CACHE_HOME=/tmp/.cache && pip install -r requirements.txt -t /asset-output && cp lambda_function.py /asset-output/'],
        },
      }),
      timeout: cdk.Duration.minutes(10),
      memorySize: 10240,
      ephemeralStorageSize: cdk.Size.gibibytes(10),
      environment: lambdaEnv,
      role: moduleRole,
    });

    // CSV Lambda
    const csvLambda = new lambda.Function(this, 'ExportCsv', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/export-csv')),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      layers: [props.sharedLayer],
      environment: lambdaEnv,
      role: moduleRole,
      ...dbVpcConfig,
    });

    // Complete Lambda
    const completeLambda = new lambda.Function(this, 'ExportComplete', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/export-complete')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      layers: [props.sharedLayer],
      environment: lambdaEnv,
      role: moduleRole,
      ...dbVpcConfig,
    });

    // Step Function
    const initTask = new stepfunctionsTasks.LambdaInvoke(this, 'InitTask', {
      lambdaFunction: initLambda,
      outputPath: '$.Payload',
    });

    const workerTask = new stepfunctionsTasks.LambdaInvoke(this, 'WorkerTask', {
      lambdaFunction: workerLambda,
      outputPath: '$.Payload',
    });

    const mapState = new stepfunctions.Map(this, 'ProcessImagesets', {
      itemsPath: '$.stepIds',
      maxConcurrency: 5,
      resultPath: '$.mapResults',
    });
    mapState.itemProcessor(workerTask);

    const csvTask = new stepfunctionsTasks.LambdaInvoke(this, 'GenerateCsv', {
      lambdaFunction: csvLambda,
      outputPath: '$.Payload',
    });

    const completeTask = new stepfunctionsTasks.LambdaInvoke(this, 'CompleteJob', {
      lambdaFunction: completeLambda,
      payload: stepfunctions.TaskInput.fromObject({
        jobId: stepfunctions.JsonPath.stringAt('$.jobId'),
      }),
    });

    const failTask = new stepfunctionsTasks.LambdaInvoke(this, 'FailJob', {
      lambdaFunction: completeLambda,
      payload: stepfunctions.TaskInput.fromObject({
        jobId: stepfunctions.JsonPath.stringAt('$.jobId'),
        error: 'true',
      }),
    });

    const definition = initTask
      .next(mapState)
      .next(csvTask)
      .next(completeTask);

    initTask.addCatch(failTask, { resultPath: '$.error' });
    mapState.addCatch(failTask, { resultPath: '$.error' });

    const stateMachine = new stepfunctions.StateMachine(this, 'ExportStateMachine', {
      ...stateMachineObservability(this, 'ExportStateMachine'),
      definitionBody: stepfunctions.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(24),
    });

    // Grant processing jobs API Lambda permission to start this Step Function
    stateMachine.grantStartExecution(props.processingJobsApiLambda);

    // Seed the export processing-job row. The RDS Data API is disabled on the
    // cluster (EdgeSwarm F-7), so the row is written by a small in-VPC seed
    // Lambda through the RDS Proxy as this module's app DB user. CDK's shared
    // custom-resource runner invokes it with the config built here at synth
    // time; both run on this module's role (no extra role). The config is part
    // of the payload, so a changed state-machine ARN reseeds on the next deploy.
    const exportSeedConfig = JSON.stringify({
      descriptor: {
        parameters: [
          { name: 'virtualFolderId', type: 'virtual-folder-select', label: 'Virtual Folder', required: true },
          { name: 'exportMode', type: 'select', label: 'Export Mode', options: ['per-study', 'per-series'], required: true },
          { name: 'exportName', type: 'text', label: 'Export Name', required: true },
        ],
      },
      stepFunctionArn: stateMachine.stateMachineArn,
      exportBucket: exportBucket.bucketName,
    });
    // Fixed name so the module role can be granted invoke by ARN string: a
    // reference to the function's own ARN in the role it runs on is a cycle.
    const seedFunctionName = `${props.stackPrefix}-export-seed`;
    const seedLambda = new lambda.Function(this, 'ExportSeed', {
      functionName: seedFunctionName,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda/export-seed')),
      timeout: cdk.Duration.seconds(30),
      environment: lambdaEnv,
      layers: [props.sharedLayer],
      role: moduleRole,
      ...dbVpcConfig,
    });
    moduleRole.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [`arn:${cdk.Aws.PARTITION}:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:${seedFunctionName}`] }));
    const exportSeed = new cr.AwsCustomResource(this, 'ExportJobSeed', {
      onUpdate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: seedFunctionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({
            jobId: 'dicom-vf-export',
            name: 'DICOM Virtual Folder Export',
            description: 'Export DICOM data from a virtual folder to S3 as ZIP files with a CSV manifest',
            config: exportSeedConfig,
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of('dicom-vf-export'),
      },
      role: moduleRole, // 1-role-per-module
      installLatestAwsSdk: false,
    });
    exportSeed.node.addDependency(seedLambda);
    exportSeed.node.addDependency(stateMachine);
  }
}
