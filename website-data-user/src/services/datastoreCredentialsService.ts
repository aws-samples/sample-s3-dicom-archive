// Managed imaging service removed: every datastore is now served from S3 via
// plain bearer-token DICOMweb, so there is no SigV4 imaging-service credential
// to vend or cache. This module previously fetched and cached temporary SigV4
// credentials per datastore (apiClient.getDatastoreCredentials). That flow is
// gone. The export is retained as an inert no-op so any lingering import does not
// break; it fetches nothing and caches nothing.

export const datastoreCredentialsService = {
  invalidate(_datastoreId: string): void {
    // no-op: no credentials are cached in the S3 model
  },
};
