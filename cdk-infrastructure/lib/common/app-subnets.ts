import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Subnet selection helpers for the in-VPC-only Phase 4 (natGateways: 0) layout.
 *
 * Default VPC (inVpcOnly off, or an existing VPC that has egress subnets): the app tier runs
 * in the PRIVATE_WITH_EGRESS subnets and the database in the PRIVATE_ISOLATED subnets, exactly
 * as before. These helpers return the same selections the call sites used to hard-code, so the
 * synthesized template is unchanged.
 *
 * Zero-NAT VPC (NetworkStack under inVpcOnly): CDK refuses PRIVATE_WITH_EGRESS subnets without a
 * NAT, so the app subnet group is retyped to PRIVATE_ISOLATED and named APP_SUBNET_GROUP. The VPC
 * then has two isolated groups, so selecting by type would mix them; both helpers select by
 * group name instead. The decision is read from the VPC itself (does it have any egress
 * subnets?), so no prop has to be threaded through the ~20 stacks that place lambdas/tasks.
 *
 * An existing VPC with NO egress subnets must tag its subnets with aws-cdk:subnet-name =
 * APP_SUBNET_GROUP / DB_SUBNET_GROUP; otherwise synth fails loudly here (never a silent
 * misplacement).
 */
export const APP_SUBNET_GROUP = 'App';
export const DB_SUBNET_GROUP = 'Private';

function hasEgressSubnets(vpc: ec2.IVpc): boolean {
  return vpc.privateSubnets.length > 0;
}

/** Subnets for in-VPC lambdas, Fargate tasks, internal load balancers and interface endpoints. */
export function appSubnets(vpc: ec2.IVpc): ec2.SubnetSelection {
  return hasEgressSubnets(vpc)
    ? { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
    : { subnetGroupName: APP_SUBNET_GROUP };
}

/** Subnets for the Aurora cluster and RDS Proxy. */
export function dbSubnets(vpc: ec2.IVpc): ec2.SubnetSelection {
  return hasEgressSubnets(vpc)
    ? { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    : { subnetGroupName: DB_SUBNET_GROUP };
}
