import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface ModuleRoleOptions {
  /** true when the module has in-VPC lambdas that need ENI management. */
  vpc?: boolean;
  /** Optional explicit role name. Omit to let CDK auto-name. */
  roleName?: string;
  /** Optional human description. */
  description?: string;
}

/**
 * Create ONE shared execution role for a module's ordinary Lambda functions.
 *
 * The DICOM-archive stacks historically let every `new lambda.Function` auto-
 * generate its own role (one role per lambda, ~140 total). Because the vast
 * majority of those roles carry only `rds-data:ExecuteStatement` + `GetSecretValue`
 * (± `events:PutEvents`) scoped to the module's own resources, one shared role per
 * module — granted the union of that module's ordinary-lambda permissions and passed
 * as `role:` to each of them — collapses the count with the union confined to the
 * module's own (already tightly-scoped) resources.
 *
 * Attach the union grants to the returned role with `role.addToPolicy(...)` once,
 * then pass `role` to every ordinary lambda in the module. Roles flagged dedicated
 * (ECS task/exec, Batch job, IAM/Roles-Anywhere provisioners, name-referenced,
 * exported cross-stack, framework/CI-CD) are NOT created here — leave them as-is.
 */
export function createModuleRole(
  scope: Construct,
  id: string,
  opts: ModuleRoleOptions = {}
): iam.Role {
  const managedPolicies = [
    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
  ];
  if (opts.vpc) {
    managedPolicies.push(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
    );
  }
  return new iam.Role(scope, id, {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    managedPolicies,
    roleName: opts.roleName,
    description: opts.description ?? `Shared module execution role (${id})`,
  });
}
