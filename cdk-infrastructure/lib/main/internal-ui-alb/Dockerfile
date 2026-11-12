# Internal UI front door for the in-VPC-only posture (replaces CloudFront).
# nginx serves the SPA bundles synced from the UI S3 bucket at container start;
# SPA routing mirrors the CloudFront Function in ui-hosting-stack.ts.
#
# RUN-FREE BY DESIGN. Two hard constraints in this build environment:
#   1. No outbound internet during build -> cannot `apk add` / `apt-get install` / curl.
#   2. CDK cross-builds this for linux/amd64 via emulation on an arm64 host, and this host
#      has no working amd64 emulation, so ANY `RUN` step (even a shell builtin) fails 255.
# So the image is pure FROM + COPY: the AWS CLI v2 tree is copied from its official image
# (its internal `current`/`bin/aws`->`dist/aws` symlinks are preserved by COPY), and the
# entrypoint invokes the CLI by its full path /usr/local/aws-cli/v2/current/bin/aws. The
# entrypoint is copied with an explicit executable mode via COPY --chmod (no RUN chmod).
FROM public.ecr.aws/aws-cli/aws-cli:2.38.4 AS awscli

FROM public.ecr.aws/nginx/nginx:1.27
COPY --from=awscli /usr/local/aws-cli/ /usr/local/aws-cli/
COPY nginx.conf /etc/nginx/nginx.conf
COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh

# UI_BUCKET is injected by the task definition. The entrypoint syncs the bundles
# then execs nginx in the foreground.
ENV UI_ROOT=/usr/share/nginx/html
# Full path to the copied AWS CLI v2 launcher (no /usr/local/bin/aws symlink is created,
# since that would need a RUN). The entrypoint uses $AWS_CLI.
ENV AWS_CLI=/usr/local/aws-cli/v2/current/bin/aws
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
