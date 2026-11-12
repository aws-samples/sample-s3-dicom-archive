import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { InternalUiFrontDoor } from './internal-ui-front-door';

export interface UiHostingStackProps extends cdk.NestedStackProps {
  stackPrefix: string;
  environment: string;
  /** Route /volview/* to the VolView app (config.json volviewFeature). */
  volviewViewer?: boolean;
  /** In-VPC-only Phase 3 (config.json inVpcOnly): replace the CloudFront distribution with an
   *  internal ALB + nginx Fargate front door. Absent = CloudFront, exactly as before. */
  internalFrontDoor?: {
    vpc: ec2.IVpc;
    /** Operator ACM cert; omit together with selfSigned=true to mint a self-signed one. */
    certificateArn?: string;
    selfSigned?: boolean;
    domainName: string;
    allowedCidrs?: string[];
  };
}

export class UiHostingStack extends cdk.NestedStack {
  public readonly bucket: s3.Bucket;
  /** CloudFront-only; undefined under the internal front door. */
  public readonly securityHeadersPolicy?: cloudfront.ResponseHeadersPolicy;
  /** CloudFront-only; undefined under the internal front door. */
  public readonly distribution?: cloudfront.Distribution;
  /** In-VPC-only front door; undefined when CloudFront is used. */
  public readonly internalFrontDoor?: InternalUiFrontDoor;
  /** The hostname every app is served from (CloudFront domain, or the private front-door
   *  hostname). baseUrl is https://<frontDoorDomain>. */
  public readonly frontDoorDomain: string;

  constructor(scope: Construct, id: string, props: UiHostingStackProps) {
    super(scope, id, props);

    const { stackPrefix, environment } = props;

    // Create S3 bucket for UI hosting (all apps: admin/, data-user/, ohif/, slim/)
    this.bucket = new s3.Bucket(this, 'UiBucket', {
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    });

    if (props.internalFrontDoor) {
      // In-VPC-only: no CloudFront at all. nginx reads the bucket with its task role over
      // the S3 gateway endpoint (the bucket stays BLOCK_ALL; no OAC bucket policy needed).
      const frontDoor = new InternalUiFrontDoor(this, 'InternalFrontDoor', {
        stackPrefix,
        vpc: props.internalFrontDoor.vpc,
        bucket: this.bucket,
        certificateArn: props.internalFrontDoor.certificateArn,
        selfSigned: props.internalFrontDoor.selfSigned,
        domainName: props.internalFrontDoor.domainName,
        allowedCidrs: props.internalFrontDoor.allowedCidrs,
      });
      this.internalFrontDoor = frontDoor;
      this.frontDoorDomain = props.internalFrontDoor.domainName;

      new cdk.CfnOutput(this, 'UiBucketName', {
        value: this.bucket.bucketName,
        exportName: `${stackPrefix}-ui-bucket-name-v2`,
        description: 'UI hosting S3 bucket name',
      });
      new cdk.CfnOutput(this, 'FrontDoorUrl', {
        value: `https://${this.frontDoorDomain}`,
        exportName: `${stackPrefix}-front-door-url`,
        description: 'Internal UI front door URL (private hostname)',
      });
      new cdk.CfnOutput(this, 'FrontDoorAlbDns', {
        value: frontDoor.alb.loadBalancerDnsName,
        exportName: `${stackPrefix}-front-door-alb-dns`,
        description: 'Internal ALB DNS name: point the private hostname (CNAME/alias) at this',
      });
      return;
    }

    // CloudFront reads the private S3 bucket via Origin Access Control (OAC),
    // the modern replacement for the legacy Origin Access Identity (OAI).
    // S3BucketOrigin.withOriginAccessControl() provisions the OAC and writes
    // the least-privilege bucket policy automatically, so no manual grant is
    // needed here (and the bucket stays BLOCK_ALL public access).

    // CloudFront Function for SPA routing per virtual folder
    const spaRoutingFunction = new cloudfront.Function(this, 'SpaRoutingFunction', {
      functionName: `${stackPrefix}-spa-routing`,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Root -> redirect to /admin/
  if (uri === '/') {
    return { statusCode: 302, statusDescription: 'Found', headers: { location: { value: '/admin/' } } };
  }

  // Rewrite /dicom-microscopy-viewer/* to /ohif/dicom-microscopy-viewer/*
  if (uri.startsWith('/dicom-microscopy-viewer/')) {
    request.uri = '/ohif' + uri;
    return request;
  }

  // Determine which app this request belongs to
  var apps = ['admin', 'data-user', 'ohif', 'slim'${props.volviewViewer ? ", 'volview'" : ''}];
  for (var i = 0; i < apps.length; i++) {
    var prefix = '/' + apps[i];
    if (uri === prefix || uri.startsWith(prefix + '/')) {
      var path = uri.substring(prefix.length) || '/';

      // SLIM: /slim/studies/* is always a SPA route (DICOM UIDs contain dots)
      if (apps[i] === 'slim' && path.startsWith('/studies/')) {
        request.uri = prefix + '/index.html';
        return request;
      }

      // If URI has a file extension, serve as-is (static asset)
      if (path.lastIndexOf('.') > path.lastIndexOf('/')) {
        // OHIF: ONNX wasm loader resolves files relative to page URL
        if (apps[i] === 'ohif') {
          var assetDirs = ['/ort/', '/assets/'];
          for (var j = 0; j < assetDirs.length; j++) {
            var idx = path.indexOf(assetDirs[j]);
            if (idx > 0) {
              request.uri = prefix + path.substring(idx);
              return request;
            }
          }
        }
        return request;
      }

      // SPA fallback: rewrite to app's index.html
      request.uri = prefix + '/index.html';
      return request;
    }
  }

  // Static paths — serve directly from S3
  if (uri.startsWith('/installers/') || uri.startsWith('/CHANGELOG')) {
    return request;
  }

  // Unknown path -> 404
  return { statusCode: 404, statusDescription: 'Not Found', headers: { 'content-type': { value: 'text/plain' } }, body: 'Not Found' };
}
`),
    });

    // Create CloudFront distribution
    // Baseline security headers on every response of the
    // shared origin (admin UI, data-user UI, OHIF, SLIM, DICOMweb). The CSP is
    // deliberately minimal (framing, plugins, <base>) so the third-party viewers
    // keep working; a full script-src policy needs per-app tuning (see E-2).
    // no-referrer keeps viewer launch tokens out of Referer headers.
    this.securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: 'Baseline security headers',
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(730), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.SAMEORIGIN, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        contentSecurityPolicy: {
          // object-src allows our own origin and blob: (a blob: URL is usable
          // only by the page that created it). OHIF renders encapsulated PDFs
          // in <object data="blob:...">; 'none' blocked them ("No viewer
          // installed for application/pdf"). Cross-origin <object> stays blocked.
          contentSecurityPolicy: "frame-ancestors 'self'; object-src 'self' blob:; base-uri 'self'",
          override: false,
        },
      },
    });
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: this.securityHeadersPolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        functionAssociations: [{
          function: spaRoutingFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      // Explicit modern TLS floor at the edge (the default cert otherwise picks
      // a provider default). Clients negotiating below TLS 1.2 are refused.
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      // NOTE: No WAF web ACL is attached. A WAFv2 web ACL can be added here via
      // `webAclId` for rate-limiting / managed rule groups (e.g. AWS managed
      // common rule set, IP reputation) on this PHI-fronting distribution. It
      // is intentionally OFF by default (cost + false-positive tuning); enable
      // it per deployment.
      comment: `Archive UI Distribution for ${stackPrefix} in ${environment} environment`,
    });
    this.frontDoorDomain = this.distribution.distributionDomainName;

    // CloudFormation Exports (v2 suffix to avoid conflicts)
    new cdk.CfnOutput(this, 'UiBucketName', {
      value: this.bucket.bucketName,
      exportName: `${stackPrefix}-ui-bucket-name-v2`,
      description: 'UI hosting S3 bucket name',
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      exportName: `${stackPrefix}-cloudfront-url-v2`,
      description: 'CloudFront distribution URL',
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: this.distribution.distributionId,
      exportName: `${stackPrefix}-cloudfront-distribution-id-v2`,
      description: 'CloudFront distribution ID',
    });
  }
}
