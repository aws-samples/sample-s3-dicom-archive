import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

/**
 * Logging + X-Ray tracing for a Step Functions state machine (cdk-nag
 * AwsSolutions-SF1 / SF2). Spread into the StateMachine props:
 *
 *   new sfn.StateMachine(this, 'X', { ...stateMachineObservability(this, 'X'), ... })
 *
 * Level ALL records every state transition, but includeExecutionData is false:
 * state inputs/outputs (which can carry patient identifiers) are never written
 * to CloudWatch Logs. The log group uses the /aws/vendedlogs/ prefix AWS
 * recommends for Step Functions.
 */
export function stateMachineObservability(scope: Construct, id: string): Pick<sfn.StateMachineProps, 'logs' | 'tracingEnabled'> {
  const destination = new logs.LogGroup(scope, `${id}Logs`, {
    logGroupName: `/aws/vendedlogs/states/${scope.node.addr}-${id}`,
    retention: logs.RetentionDays.ONE_YEAR,
  });
  return {
    logs: { destination, level: sfn.LogLevel.ALL, includeExecutionData: false },
    tracingEnabled: true,
  };
}
