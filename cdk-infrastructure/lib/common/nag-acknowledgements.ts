import { Stack, Token, Validations } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

/**
 * cdk-nag (AwsSolutions) acknowledgements, each with the reason it is accepted.
 * Applied only for `npm run nag` (`--context cdkNag=true`). Generated from the
 * reviewed findings of the first cdk-nag run; see docs/security/SECURITY-SUPPRESSIONS.md.
 *
 * - Small rule groups are acknowledged on the exact flagged resources, so the
 *   same rule on any NEW resource is still reported.
 * - IAM5 (wildcard) findings are acknowledged per distinct finding id; ids are
 *   templated with the stack prefix / account / Region so they match in any
 *   deployment. A NEW wildcard pattern is still reported.
 */
export function applyNagAcknowledgements(stack: Stack, stackPrefix: string): void {
  const p = stackPrefix;
  const acct = Token.isUnresolved(stack.account) ? '<AWS::AccountId>' : stack.account;
  const region = Token.isUnresolved(stack.region) ? '<AWS::Region>' : stack.region;
  const ack = (scope: IConstruct, id: string, reason: string) => Validations.of(scope).acknowledge({ id, reason });
  // Resolve a construct path relative to `stack` ("A/B/Resource"); undefined if this
  // configuration does not create it (e.g. networkMode-specific resources).
  const at = (path: string): IConstruct | undefined => {
    let node: IConstruct | undefined = stack;
    for (const part of path.split('/')) { node = node?.node.tryFindChild(part); }
    return node;
  };
  const ackAt = (paths: string[], id: string, reason: string) => {
    for (const path of paths) { const n = at(path); if (n) ack(n, id, reason); }
  };

  // API methods use a Lambda TOKEN authorizer, not a Cognito user-pool authorizer.
  ack(stack, 'AwsSolutions-COG4', 'Every API method is protected by a Lambda TOKEN authorizer that verifies the Cognito user-pool JWT (JWKS keys, RS256 pinned, iss, token_use, client_id/aud, exp) and then applies the solution\'s RBAC, which a Cognito user-pool authorizer cannot do. OPTIONS (CORS preflight) methods are unauthenticated by design.');

  // AWS managed service-role policies.
  const iam4Reason = 'AWS managed service-role policy recommended by AWS for this role type (Lambda logging / VPC ENI management, ECS task execution, Batch EC2 instance role); it grants no data access.';
  ack(stack, `AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]`, iam4Reason);
  ack(stack, `AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole]`, iam4Reason);
  ack(stack, `AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy]`, iam4Reason);
  ack(stack, `AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role]`, iam4Reason);

  // EC23: rule cannot evaluate a CloudFormation reference in the ingress CIDR.
  ackAt([`Network/Vpc/EcrApiEndpoint/SecurityGroup/Resource`, `Network/Vpc/EcrDkrEndpoint/SecurityGroup/Resource`, `Network/Vpc/LogsEndpoint/SecurityGroup/Resource`, `Network/Vpc/SecretsManagerEndpoint/SecurityGroup/Resource`, `Network/Vpc/StsEndpoint/SecurityGroup/Resource`, `Network/Vpc/SqsEndpoint/SecurityGroup/Resource`, `Network/Vpc/SnsEndpoint/SecurityGroup/Resource`, `Network/Vpc/EventBridgeEndpoint/SecurityGroup/Resource`, `Network/Vpc/StepFunctionsEndpoint/SecurityGroup/Resource`, `Network/Vpc/LambdaEndpoint/SecurityGroup/Resource`, `Network/Vpc/SsmEndpoint/SecurityGroup/Resource`, `Network/Vpc/SsmMessagesEndpoint/SecurityGroup/Resource`, `Network/Vpc/Ec2MessagesEndpoint/SecurityGroup/Resource`, `Network/Vpc/EcsEndpoint/SecurityGroup/Resource`, `Network/Vpc/CloudWatchEndpoint/SecurityGroup/Resource`, `Network/Vpc/AppAutoScalingEndpoint/SecurityGroup/Resource`, `Network/Vpc/Ec2Endpoint/SecurityGroup/Resource`, `Network/Vpc/BedrockRuntimeEndpoint/SecurityGroup/Resource`, `Network/Vpc/CognitoIdpEndpoint/SecurityGroup/Resource`, `Network/Vpc/CognitoIdentityEndpoint/SecurityGroup/Resource`, `Network/Vpc/ExecuteApiEndpoint/SecurityGroup/Resource`, `Network/Vpc/BatchEndpoint/SecurityGroup/Resource`, `Network/Vpc/KmsEndpoint/SecurityGroup/Resource`, `Network/Vpc/SesEndpoint/SecurityGroup/Resource`, `Network/Vpc/RdsDataEndpoint/SecurityGroup/Resource`, `Network/Vpc/IamEndpoint/SecurityGroup/Resource`, `UiHosting/InternalFrontDoor/AlbSg/Resource`],
    'AwsSolutions-EC23', 'Ingress is limited to the VPC CIDR (VPC interface endpoints: HTTPS from the VPC; internal UI ALB: the VPC CIDR or the operator-configured allowedCidrs). The rule cannot evaluate the CIDR because it is a CloudFormation reference.');

  // IAM5 Resource::* - acknowledged only on the reviewed policies.
  ackAt([`Database/DbSecretRotation/inlinePolicyAddedToExecutionRole-1/Resource`, `Database/DbSecretRotation/inlinePolicyAddedToExecutionRole-3/Resource`, `Database/DbSecretRotation/inlinePolicyAddedToExecutionRole-5/Resource`, `Database/DbSecretRotation/inlinePolicyAddedToExecutionRole-7/Resource`, `Database/DbSecretRotation/inlinePolicyAddedToExecutionRole-9/Resource`, `Database/DbSecretRotation/inlinePolicyAddedToExecutionRole-11/Resource`, `Auth/AuthenticatedRole/DefaultPolicy/Resource`, `UiHosting/InternalFrontDoor/TaskDef/ExecutionRole/DefaultPolicy/Resource`, `UiHosting/InternalFrontDoor/SelfSignedCert/Fn/inlinePolicyAddedToExecutionRole-0/Resource`, `UiHosting/LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a/ServiceRole/DefaultPolicy/Resource`, `SharedCodeBuildRole/OverflowPolicy1/Resource`, `DatastoreWorkflow/DatastoreWorkflowRole/DefaultPolicy/Resource`, `DatastoreWorkflow/ImportDatastoreApi/inlinePolicyAddedToExecutionRole-3/Resource`, `DicomWebService/ExecutionRole/DefaultPolicy/Resource`, `ImportCleanupPipeline/CleanupStateMachine/Role/DefaultPolicy/Resource`, `ImportPipeline/StatsBatchSyncStateMachine/Role/DefaultPolicy/Resource`, `ConfigService/GetConfig/inlinePolicyAddedToExecutionRole-4/Resource`, `ConfigService/GetConfig/inlinePolicyAddedToExecutionRole-5/Resource`, `ConfigService/CleanupEventSourceMappingPolicy/Resource`, `Dashboard/DashboardModuleRole/DefaultPolicy/Resource`, `ProcessingJobs/ProcessingJobsModuleRole/DefaultPolicy/Resource`, `ProcessingJobs/Plugins/PluginExecRole/DefaultPolicy/Resource`, `Export/ExportStateMachine/Role/DefaultPolicy/Resource`, `DicomService/TaskExecutionRole/DefaultPolicy/Resource`, `DicomService/TaskRole/DefaultPolicy/Resource`],
    'AwsSolutions-IAM5[Resource::*]', `Actions that do not support resource-level permissions (AWS requires Resource '*'): ecr:GetAuthorizationToken, logs:*LogDelivery / Describe* (Step Functions logging), xray:PutTraceSegments / PutTelemetryRecords / GetSampling*, s3:ListAllMyBuckets, secretsmanager:GetRandomPassword, sqs:ListQueues, lambda:*EventSourceMapping(s), ec2:DescribeManagedPrefixLists, cloudwatch:GetMetricData, batch:DescribeJobs, acm:ImportCertificate (new import), logs:PutRetentionPolicy (CDK LogRetention).`);

  // Self-signed front-door cert provider: ACM grants are inline on its own role
  // (they must outlive the custom resource on stack delete).
  ackAt(['UiHosting/InternalFrontDoor/SelfSignedCert/FnRole'], 'AwsSolutions-IAM5[Resource::*]',
    'acm:ImportCertificate only, conditioned on aws:RequestedRegion = this Region; a new certificate has no ARN until it is imported, so this action cannot be ARN-scoped. Delete/Describe/AddTags are scoped to this account and Region\'s ACM certificate ARNs.');
  // Config background role: orphaned per-client queue sweep (interface-servers-cleanup).
  ackAt(['ConfigService/ConfigBackgroundRole'], 'AwsSolutions-IAM5[Resource::*]',
    'sqs:ListQueues only, which does not support resource-level permissions (the function filters by QueueNamePrefix = this stack prefix); ListQueueTags is scoped to this stack\'s queue ARNs and DeleteQueue stays tag-conditioned.');
  // CDK creates the role's OverflowPolicyN children late in synthesis, after this
  // runs, so acknowledge on the role itself (covers its child policies).
  ackAt(['SharedCodeBuildRole'], 'AwsSolutions-IAM5[Resource::*]',
    'ecr:GetAuthorizationToken only (in the CDK-generated overflow policy); this action does not support resource-level permissions.');
  // DICOM service task role: SQS limited to this account/Region and, by ABAC
  // conditions, to queues tagged with this deployment AND this location.
  ackAt(['DicomService/TaskRole'], `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:sqs:<AWS::Region>:<AWS::AccountId>:*]`,
    'Location queues are created at runtime; the statement is limited to this account/Region and conditioned on aws:ResourceTag/Deployment = this stack prefix and aws:ResourceTag/location-id = this location (ABAC).');

  // IAM5 scoped wildcards (one entry per distinct finding).
  ack(stack, `AwsSolutions-IAM5[Action::s3:Abort*]`,
    `CDK bucket grant helpers (grantRead/grantReadWrite/grantDelete) emit these S3 action wildcards; every statement is scoped to a single bucket's ARN and its objects.`);
  ack(stack, `AwsSolutions-IAM5[Action::s3:DeleteObject*]`,
    `CDK bucket grant helpers (grantRead/grantReadWrite/grantDelete) emit these S3 action wildcards; every statement is scoped to a single bucket's ARN and its objects.`);
  ack(stack, `AwsSolutions-IAM5[Action::s3:GetBucket*]`,
    `CDK bucket grant helpers (grantRead/grantReadWrite/grantDelete) emit these S3 action wildcards; every statement is scoped to a single bucket's ARN and its objects.`);
  ack(stack, `AwsSolutions-IAM5[Action::s3:GetObject*]`,
    `CDK bucket grant helpers (grantRead/grantReadWrite/grantDelete) emit these S3 action wildcards; every statement is scoped to a single bucket's ARN and its objects.`);
  ack(stack, `AwsSolutions-IAM5[Action::s3:List*]`,
    `CDK bucket grant helpers (grantRead/grantReadWrite/grantDelete) emit these S3 action wildcards; every statement is scoped to a single bucket's ARN and its objects.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<ApiResourceTracker13C243D3.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<BuildBucket51D063EF.Arn>/*]`,
    `Object-level access inside one solution-owned bucket (or a fixed prefix of it); object keys are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<CreateS3BucketE3E55410.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<DeleteFromDBED045AB2.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<DeleteS3PrefixFunctionF5671344.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<EmptyS3BucketB8356990.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<ExportBucket4E99310E.Arn>/*]`,
    `Object-level access inside one solution-owned bucket (or a fixed prefix of it); object keys are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<ExportComplete74B1DBC7.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<ExportCsvF97D284F.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<ExportInitE7F1CE63.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<ExportWorkerEED7E921.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<InternalFrontDoorSelfSignedCertFnFF15E355.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<LocationCreator5F31EBED.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<PluginsPluginIoBucket2A8AC8DC.Arn>/*]`,
    `Object-level access inside one solution-owned bucket (or a fixed prefix of it); object keys are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<PluginsPluginIoBucket2A8AC8DC.Arn>/runs/*/steps/*/input.json]`,
    `Plugin run I/O: objects under runs/<runId>/steps/<step>/ of the solution-owned plugin I/O bucket; run and step ids are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<PluginsPluginIoBucket2A8AC8DC.Arn>/runs/*/steps/*/output/*]`,
    `Plugin run I/O: objects under runs/<runId>/steps/<step>/ of the solution-owned plugin I/O bucket; run and step ids are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<PluginsPluginIoBucket2A8AC8DC.Arn>/runs/*/steps/*/result.json]`,
    `Plugin run I/O: objects under runs/<runId>/steps/<step>/ of the solution-owned plugin I/O bucket; run and step ids are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<S3IngestFunction793700A0.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<SchemaInitFunctionF50E110F.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<SetDeletingStatusE553EDCA.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<StatsBatchSyncFunction79A7BA3F.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<TlsCertGeneratorF907ECD6.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<UiBucket6890E4C3.Arn>/*]`,
    `Object-level access inside one solution-owned bucket (or a fixed prefix of it); object keys are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<UiHostingNestedStackUiHostingNestedStackResource4178D014.Outputs.${p}UiHostingUiBucketFA5EEB4EArn>/admin/*]`,
    `Object-level access inside one solution-owned bucket (or a fixed prefix of it); object keys are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<UiHostingNestedStackUiHostingNestedStackResource4178D014.Outputs.${p}UiHostingUiBucketFA5EEB4EArn>/data-user/*]`,
    `Object-level access inside one solution-owned bucket (or a fixed prefix of it); object keys are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<UiHostingNestedStackUiHostingNestedStackResource4178D014.Outputs.${p}UiHostingUiBucketFA5EEB4EArn>/installers/*]`,
    `Object-level access inside one solution-owned bucket (or a fixed prefix of it); object keys are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<UiHostingNestedStackUiHostingNestedStackResource4178D014.Outputs.${p}UiHostingUiBucketFA5EEB4EArn>/ohif/*]`,
    `Object-level access inside one solution-owned bucket (or a fixed prefix of it); object keys are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<UiHostingNestedStackUiHostingNestedStackResource4178D014.Outputs.${p}UiHostingUiBucketFA5EEB4EArn>/slim/*]`,
    `Object-level access inside one solution-owned bucket (or a fixed prefix of it); object keys are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<UiHostingNestedStackUiHostingNestedStackResource4178D014.Outputs.${p}UiHostingUiBucketFA5EEB4EArn>/volview/*]`,
    `Object-level access inside one solution-owned bucket (or a fixed prefix of it); object keys are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<UpdateCleanupStatusFunction5342E08B.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<UpdateStatusAEC39BEF.Arn>:*]`,
    `Lambda function ARN with ':*' (its versions/aliases) - granted on one specific function, emitted by CDK's grantInvoke / Step Functions LambdaInvoke.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<UserUploadBucketE3442774.Arn>/*]`,
    `Object-level access inside one solution-owned bucket (or a fixed prefix of it); object keys are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<UserUploadBucketE3442774.Arn>/non-dicom-v2/*]`,
    `Object-level access inside one solution-owned bucket (or a fixed prefix of it); object keys are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<${p}locecsE783D9D4.Arn>/*]`,
    `Object-level access inside one solution-owned bucket (or a fixed prefix of it); object keys are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<referenceto${p}ImportPipelineNestedStackImportPipelineNestedStackResource5525AEC5Outputs${p}ImportPipelineS3IngestFunctionD408F4DBArn>:*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::<referenceto${p}UiHostingNestedStackUiHostingNestedStackResource8173080EOutputs${p}UiHostingUiBucketFA5EEB4EArn>/*]`,
    `Object-level access inside one solution-owned bucket (or a fixed prefix of it); object keys are generated at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0]`,
    `Bedrock cross-Region inference profiles route to the model in any US Region, so the foundation-model ARN must not pin a Region; scoped to two specific model IDs.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0]`,
    `Bedrock cross-Region inference profiles route to the model in any US Region, so the foundation-model ARN must not pin a Region; scoped to two specific model IDs.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:codebuild:<AWS::Region>:<AWS::AccountId>:project/${p}-*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:codebuild:<AWS::Region>:<AWS::AccountId>:report-group/${p}-*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:iam::<AWS::AccountId>:role/${p}-*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:lambda:<AWS::Region>:<AWS::AccountId>:function:${p}-DatastoreWorkflow*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/codebuild/${p}-*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::*]`,
    `Read-only bucket control-plane checks (ListBucket/GetBucketNotification/GetBucketTagging) on user-named import buckets whose names are unknown at synth; no object access.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-*-assets-<AWS::AccountId>-<AWS::Region>/*]`,
    `CDK bootstrap asset bucket for this account/Region (build projects read deployment assets).`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-*-assets-<AWS::AccountId>-<AWS::Region>]`,
    `CDK bootstrap asset bucket for this account/Region (build projects read deployment assets).`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::${p}-ds-*/*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::${p}-ds-*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:sqs:<AWS::Region>:<AWS::AccountId>:${p}-*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:states:<AWS::Region>:<AWS::AccountId>:stateMachine:${p}*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:acm:${region}:${acct}:certificate/*]`,
    `Self-signed front-door certificate is imported to ACM at deploy time; its ARN is not known in advance.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:application-autoscaling:<AWS::Region>:<AWS::AccountId>:scalable-target/*]`,
    `Location activation scales its Fargate service; service and scalable-target identifiers are created at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:batch:${region}:${acct}:job-definition/${p}-plugin-*:*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:batch:${region}:${acct}:job-definition/${p}-plugin-*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:batch:${region}:${acct}:job/*]`,
    `AWS Batch job ARNs are generated per plugin run.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0]`,
    `Bedrock cross-Region inference profiles route to the model in any US Region, so the foundation-model ARN must not pin a Region; scoped to two specific model IDs.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0]`,
    `Bedrock cross-Region inference profiles route to the model in any US Region, so the foundation-model ARN must not pin a Region; scoped to two specific model IDs.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:ec2:<AWS::Region>:<AWS::AccountId>:security-group/*]`,
    `Conditioned on aws:ResourceTag/Deployment = this stack; NLB security groups are managed at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:ecr:${region}:${acct}:repository/${p}-plugin-*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:ecs:<AWS::Region>:<AWS::AccountId>:service/*/*]`,
    `Location activation scales its Fargate service; service and scalable-target identifiers are created at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:execute-api:<AWS::Region>:<AWS::AccountId>:*/v1/POST/api/config]`,
    `Single route only: POST /api/config (any stage) of this solution's API.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:execute-api:${region}:${acct}:<ApiF70053CD>/*/*/*]`,
    `Scoped to this solution's RestApi (any stage/method/path); per-route authorization is enforced by the Lambda authorizer on every method.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:execute-api:${region}:${acct}:<referenceto${p}ApiNestedStackApiNestedStackResourceC1500E15Outputs${p}Api1F6C001FRef>/*/POST/api/config]`,
    `Single route only: POST /api/config (any stage) of this solution's API.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:iam::<AWS::AccountId>:role/Location-*]`,
    `Per-location IAM Roles Anywhere roles are created at runtime; every Location-* role is capped by the LocationRoleBoundary permissions boundary.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:lambda:<AWS::Region>:<AWS::AccountId>:event-source-mapping:*]`,
    `Event source mapping UUIDs are created at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:lambda:${region}:${acct}:function:${p}*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:lambda:${region}:${acct}:function:${p}-*DatastoreBackfill*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:lambda:${region}:${acct}:function:${p}-*InterfaceServersCleanup*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:lambda:${region}:${acct}:function:${p}-plugin-*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:rolesanywhere:<AWS::Region>:<AWS::AccountId>:profile/*]`,
    `IAM Roles Anywhere profiles/trust anchors are created per location at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:rolesanywhere:<AWS::Region>:<AWS::AccountId>:trust-anchor/*]`,
    `IAM Roles Anywhere profiles/trust anchors are created per location at runtime.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:s3:::*]`,
    `Statement of the LocationRoleBoundary permissions boundary (a ceiling): imported datastores have arbitrary bucket names; each location's inline policy narrows it to that location's buckets.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:s3:::cdk-hnb659fds-assets-${acct}-${region}/*]`,
    `CDK bootstrap asset bucket for this account/Region (build projects read deployment assets).`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:s3:::${p}-ds-*/*.extracted/*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:s3:::${p}-ds-*/*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:s3:::${p}-ds-*/plugin-derived/*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:s3:::${p}-ds-*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:s3:::${p}-loc-*/*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:s3:::${p}-loc-*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:secretsmanager:<AWS::Region>:<AWS::AccountId>:secret:${p}-dicom-tls-certs*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:sqs:<AWS::Region>:<AWS::AccountId>:*-heartbeat]`,
    `Per-location queues created at runtime; this statement is part of the LocationRoleBoundary permissions boundary (a ceiling, narrowed by each location's inline policy).`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:sqs:<AWS::Region>:<AWS::AccountId>:*-inbound]`,
    `Per-location queues created at runtime; this statement is part of the LocationRoleBoundary permissions boundary (a ceiling, narrowed by each location's inline policy).`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:sqs:<AWS::Region>:<AWS::AccountId>:*-outbound]`,
    `Per-location queues created at runtime; this statement is part of the LocationRoleBoundary permissions boundary (a ceiling, narrowed by each location's inline policy).`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:sqs:<AWS::Region>:<AWS::AccountId>:${p}-*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);
  ack(stack, `AwsSolutions-IAM5[Resource::arn:aws:states:${region}:${acct}:stateMachine:${p}*]`,
    `Scoped to this deployment's stack-prefixed resource names; the names are generated at runtime (per datastore, location or plugin) or a direct ARN reference would create a stack dependency cycle.`);

  // Remaining rules, on the exact flagged resources.
  ackAt([`BuildBucket/Resource`, `UiHosting/UiBucket/Resource`, `ImportPipeline/UserUploadBucket/Resource`, `ProcessingJobs/Plugins/PluginIoBucket/Resource`, `Export/ExportBucket/Resource`, `DicomService/${p}-loc-ecs/Resource`],
    'AwsSolutions-S1', `Accepted (demo scope): S3 server access logging is not enabled, to avoid an extra log bucket and its cost. Deployers should enable server access logging or CloudTrail S3 data events before use beyond the demo.`);
  ackAt([`Network/Vpc/Resource`],
    'AwsSolutions-VPC7', `Accepted (demo scope): VPC Flow Logs are not enabled, for cost. Deployers should enable them before use beyond the demo.`);
  ackAt([`Database/AuroraCluster/Resource`],
    'AwsSolutions-RDS6', `IAM database authentication is not used: connections use Secrets Manager credentials (rotated by the DbSecretRotation function) over TLS with certificate and hostname verification, through RDS Proxy.`);
  ackAt([`Database/AuroraCluster/Resource`],
    'AwsSolutions-RDS11', `Accepted: a non-default port is obfuscation, not a control. The cluster is in private subnets and reachable only from the solution's Lambda/ECS security groups.`);
  ackAt([`Database/AuroraCluster/Resource`],
    'AwsSolutions-RDS14', `Accepted (demo scope): Aurora Backtrack is not enabled; recovery relies on Aurora automated backups and point-in-time restore.`);
  ackAt([`DeidHashPepperSecret/Resource`, `Interoperability/ConfigZipPassword/Resource`, `ConfigService/DicomServiceAuthSecret/Resource`],
    'AwsSolutions-SMG4', `Accepted: these secrets cannot rotate automatically without breaking data or clients - the de-identification hash pepper (rotation would change every pseudonymous identifier), the location configuration-package password (rotation invalidates packages already distributed), and the shared DICOM service auth secret (rotation needs a coordinated service restart). Rotate manually when required.`);
  ackAt([`Auth/UserPool/Resource`],
    'AwsSolutions-COG8', `Accepted (demo scope): Cognito Plus tier (threat protection) is not enabled, for cost. Deployers can enable it on the user pool.`);
  ackAt([`UiHosting/InternalFrontDoor/TaskDef/Resource`, `DicomWebService/TaskDef/Resource`, `DicomService/DicomTaskDefinition/Resource`],
    'AwsSolutions-ECS2', `Environment variables hold configuration only (names, ARNs, flags). Secrets are referenced by ARN/name and read from Secrets Manager at runtime; no secret value is in the task definition.`);
  ackAt([`UiHosting/InternalFrontDoor/Alb/Resource`, `DicomService/DicomNLB/Resource`],
    'AwsSolutions-ELB2', `Accepted (demo scope): load balancer access logs are not enabled, for cost. Deployers should enable them before use beyond the demo.`);
  ackAt([`Api/Api/Resource`],
    'AwsSolutions-APIG2', `Request bodies and parameters are validated in each Lambda handler (type, allowlist and ownership checks) rather than with API Gateway request models.`);
  ackAt([`Api/Api/DeploymentStage.v1/Resource`],
    'AwsSolutions-APIG1', `Accepted (demo scope): API Gateway access logging is not enabled (it needs an account-level CloudWatch role). Every API action is recorded in the solution's own audit trail; deployers should enable access logging before use beyond the demo.`);
  ackAt([`Api/Api/DeploymentStage.v1/Resource`],
    'AwsSolutions-APIG3', `Accepted (demo scope): no AWS WAF web ACL on the API stage, for cost. Deployers should attach a WAF web ACL before use beyond the demo.`);
  ackAt([`Api/Api/DeploymentStage.v1/Resource`],
    'AwsSolutions-APIG6', `Accepted (demo scope): API Gateway execution logging is not enabled (account-level CloudWatch role needed); handler logs are in CloudWatch and actions in the audit trail.`);
  ackAt([`OhifViewer/ConfigUpdateQueue/Resource`], 'AwsSolutions-SQS3', `Kept for backward compatibility; messages are idempotent 'regenerate config' requests, so a dropped message is regenerated by the next update.`);
  ackAt([`ConfigService/HeartbeatQueue/Resource`], 'AwsSolutions-SQS3', `Transient heartbeats with 1-day retention; each is superseded by the next one, so a failed message is safely dropped instead of parked.`);
  ackAt([`OhifViewer/OhifBuildProject/Resource`, `SlimViewer/SlimBuildProject/Resource`, `VolviewViewer/VolviewBuildProject/Resource`, `DataUserUi/DataUserBuildProject/Resource`, `DimseServiceImage/DimseImageBuild/Resource`, `Cicd/CiCd/BuildProject/Resource`],
    'AwsSolutions-CB4', `Accepted: CodeBuild artifacts and logs are encrypted with the AWS managed key; a customer managed KMS key is not required for these build-only projects.`);
  ackAt([`Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C1024MiB/Resource`],
    'AwsSolutions-L1', `CDK-internal custom resource (BucketDeployment); its runtime is set by aws-cdk-lib, not by this solution.`);
}
