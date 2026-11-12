#!/bin/bash

# EventBridge Audit Trail Verification Script
# This script helps verify the EventBridge-based audit trail implementation

set -e

STACK_PREFIX="${1:?usage: $0 <stackPrefix>}"
REGION="${2:-us-east-1}"

echo "🔍 Verifying EventBridge Audit Trail Implementation"
echo "Stack Prefix: $STACK_PREFIX"
echo "Region: $REGION"
echo ""

# Check EventBridge Rule
echo "1️⃣  Checking EventBridge Rule..."
RULE_NAME="${STACK_PREFIX}-audit-events"
aws events describe-rule --name "$RULE_NAME" --event-bus-name "${STACK_PREFIX}-event-bus" --region "$REGION" > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "✅ EventBridge rule '$RULE_NAME' exists"
    
    # Get rule details
    RULE_STATE=$(aws events describe-rule --name "$RULE_NAME" --event-bus-name "${STACK_PREFIX}-event-bus" --region "$REGION" --query 'State' --output text)
    echo "   State: $RULE_STATE"
    
    # Check targets
    TARGET_COUNT=$(aws events list-targets-by-rule --rule "$RULE_NAME" --event-bus-name "${STACK_PREFIX}-event-bus" --region "$REGION" --query 'length(Targets)' --output text)
    echo "   Targets: $TARGET_COUNT"
else
    echo "❌ EventBridge rule '$RULE_NAME' not found"
    exit 1
fi
echo ""

# Check SQS Queue
echo "2️⃣  Checking Audit SQS Queue..."
QUEUE_NAME="${STACK_PREFIX}-audit-queue"
QUEUE_URL=$(aws sqs get-queue-url --queue-name "$QUEUE_NAME" --region "$REGION" --query 'QueueUrl' --output text 2>/dev/null || echo "")
if [ -n "$QUEUE_URL" ]; then
    echo "✅ Audit queue '$QUEUE_NAME' exists"
    echo "   URL: $QUEUE_URL"
else
    echo "❌ Audit queue '$QUEUE_NAME' not found"
    exit 1
fi
echo ""

# Check Lambda Functions
echo "3️⃣  Checking Lambda Functions for EVENT_BUS_NAME..."
LAMBDA_FUNCTIONS=(
    "${STACK_PREFIX}-DatastoreWorkflow-DatastoreApi"
    "${STACK_PREFIX}-SystemManagement-UsersApi"
    "${STACK_PREFIX}-SystemManagement-PrivilegeGroupsApi"
    "${STACK_PREFIX}-Interoperability-DicomInterfaceApi"
    "${STACK_PREFIX}-Interoperability-DicomEntityApi"
    "${STACK_PREFIX}-Interoperability-LocationsApi"
)

for FUNCTION_NAME in "${LAMBDA_FUNCTIONS[@]}"; do
    EVENT_BUS_NAME=$(aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --region "$REGION" --query 'Environment.Variables.EVENT_BUS_NAME' --output text 2>/dev/null || echo "")
    if [ -n "$EVENT_BUS_NAME" ] && [ "$EVENT_BUS_NAME" != "None" ]; then
        echo "✅ $FUNCTION_NAME has EVENT_BUS_NAME: $EVENT_BUS_NAME"
    else
        echo "⚠️  $FUNCTION_NAME missing EVENT_BUS_NAME"
    fi
done
echo ""

# Check IAM Permissions
echo "4️⃣  Checking IAM Permissions..."
for FUNCTION_NAME in "${LAMBDA_FUNCTIONS[@]}"; do
    ROLE_NAME=$(aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --region "$REGION" --query 'Role' --output text 2>/dev/null | awk -F'/' '{print $NF}')
    if [ -n "$ROLE_NAME" ]; then
        HAS_EVENTBRIDGE=$(aws iam list-role-policies --role-name "$ROLE_NAME" --region "$REGION" 2>/dev/null | grep -c "events:PutEvents" || echo "0")
        if [ "$HAS_EVENTBRIDGE" -gt 0 ]; then
            echo "✅ $FUNCTION_NAME has events:PutEvents permission"
        else
            # Check attached policies
            ATTACHED_POLICIES=$(aws iam list-attached-role-policies --role-name "$ROLE_NAME" --region "$REGION" --query 'AttachedPolicies[*].PolicyArn' --output text 2>/dev/null || echo "")
            echo "⚠️  $FUNCTION_NAME may be missing events:PutEvents permission (check inline policies)"
        fi
    fi
done
echo ""

# Check EventBridge Metrics
echo "5️⃣  Checking EventBridge Metrics (last 5 minutes)..."
END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%S")
START_TIME=$(date -u -d '5 minutes ago' +"%Y-%m-%dT%H:%M:%S" 2>/dev/null || date -u -v-5M +"%Y-%m-%dT%H:%M:%S")

METRICS=$(aws cloudwatch get-metric-statistics \
    --namespace AWS/Events \
    --metric-name Invocations \
    --dimensions Name=RuleName,Value="$RULE_NAME" \
    --start-time "$START_TIME" \
    --end-time "$END_TIME" \
    --period 300 \
    --statistics Sum \
    --region "$REGION" \
    --query 'Datapoints[0].Sum' \
    --output text 2>/dev/null || echo "0")

if [ "$METRICS" != "None" ] && [ "$METRICS" != "0" ]; then
    echo "✅ EventBridge rule has processed $METRICS events in the last 5 minutes"
else
    echo "ℹ️  No events processed in the last 5 minutes (this is normal if no operations were performed)"
fi
echo ""

echo "✨ Verification complete!"
echo ""
echo "📝 Next Steps:"
echo "   1. Perform a test operation (e.g., create a user)"
echo "   2. Check EventBridge metrics in CloudWatch"
echo "   3. Verify audit entry appears in the database"
echo "   4. Check the audit trail UI"
