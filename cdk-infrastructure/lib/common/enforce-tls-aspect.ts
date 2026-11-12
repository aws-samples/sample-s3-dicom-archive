import { IAspect } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { IConstruct } from 'constructs';

/**
 * Require TLS for every SQS queue and SNS topic in the app (cdk-nag
 * AwsSolutions-SQS4 / SNS3): adds a resource-policy statement that denies any
 * request made without aws:SecureTransport. AWS service integrations (S3 event
 * notifications, EventBridge, Lambda event source mappings) always use TLS, so
 * they are unaffected. Applied as an Aspect so a new queue/topic is covered
 * without remembering `enforceSSL: true`. No Sid, so it never collides with the
 * statement `enforceSSL: true` already adds on some queues (a duplicate deny is harmless).
 */
export class EnforceTlsAspect implements IAspect {
  public visit(node: IConstruct): void {
    if (node instanceof sqs.Queue) {
      node.addToResourcePolicy(new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['sqs:*'],
        resources: [node.queueArn],
        conditions: { Bool: { 'aws:SecureTransport': 'false' } },
      }));
    } else if (node instanceof sns.Topic) {
      node.addToResourcePolicy(new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['sns:Publish'],
        resources: [node.topicArn],
        conditions: { Bool: { 'aws:SecureTransport': 'false' } },
      }));
    }
  }
}
