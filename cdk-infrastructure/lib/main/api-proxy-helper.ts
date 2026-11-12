import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Attach a Lambda proxy integration to an EXISTING API Gateway resource.
 *
 * Adds an `ANY` method on the resource itself (handles requests to the resource
 * path, e.g. `/api/users`) plus a greedy `{proxy+}` child with `ANY` (handles
 * every sub-path, e.g. `/api/users/123/reset-password`). All routing below the
 * resource is then performed inside the Lambda handler, which collapses the many
 * explicit `AWS::ApiGateway::Method` / `Resource` / `Lambda::Permission`
 * resources that otherwise accumulate in the `Api` nested stack.
 *
 * The handler reconstructs named path segments using the shared
 * `/opt/nodejs/proxy-path` helper since `{proxy+}` does not provide `{id}` etc.
 *
 * @returns the `{proxy+}` proxy resource (for rare further nesting needs)
 */
export function addLambdaProxy(
  resource: apigateway.IResource,
  fn: lambda.IFunction,
  methodOptions: apigateway.MethodOptions,
): apigateway.ProxyResource {
  // ANY on the base resource → e.g. GET/POST /api/<group>
  resource.addMethod('ANY', new apigateway.LambdaIntegration(fn), methodOptions);

  // Greedy proxy → everything under /api/<group>/*
  const proxy = resource.addProxy({
    defaultIntegration: new apigateway.LambdaIntegration(fn),
    anyMethod: true,
    defaultMethodOptions: methodOptions,
  });

  return proxy;
}

/**
 * Create a new child resource `pathPart` under `parent` and attach a Lambda
 * proxy integration to it (see {@link addLambdaProxy}).
 *
 * @example
 *   addLambdaProxyGroup(apiResource, 'users', usersLambda, methodOptions);
 *   // serves /api/users and /api/users/* via usersLambda
 *
 * @returns the created base resource (so callers can attach explicit child
 *          resources at Lambda divergence points before/after, where a single
 *          `{proxy+}` would otherwise misroute sibling sub-trees)
 */
export function addLambdaProxyGroup(
  parent: apigateway.IResource,
  pathPart: string,
  fn: lambda.IFunction,
  methodOptions: apigateway.MethodOptions,
): apigateway.Resource {
  const resource = parent.addResource(pathPart);
  addLambdaProxy(resource, fn, methodOptions);
  return resource;
}
