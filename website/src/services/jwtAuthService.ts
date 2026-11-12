/**
 * JWT Authentication Service (deprecated)
 *
 * This service previously exchanged the Cognito JWT for temporary AWS credentials
 * and proxied DICOMweb calls to a managed imaging service (SigV4). Every datastore is now
 * S3-backed and served by the self-hosted DICOMweb container, which authenticates
 * the Bearer token directly (see dicomwebService.makeS3Request), so the
 * credential-exchange and proxy paths have been removed.
 *
 * The export surface is retained as inert stubs for backward compatibility; no
 * caller in the app imports it.
 */

export interface JwtCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

class JwtAuthService {
  /**
   * @deprecated Credential exchange removed. Always returns null now that all
   * datastores are S3-backed and no SigV4 credentials are needed.
   */
  async getCredentials(): Promise<JwtCredentials | null> {
    console.warn('⚠️ jwtAuthService.getCredentials is deprecated: all datastores are S3-backed and require no AWS credentials.');
    return null;
  }
}

export const jwtAuthService = new JwtAuthService();
export default jwtAuthService;
