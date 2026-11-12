/**
 * AWS SigV4 Request Signing Utility for Browser
 * Converted to TypeScript with proper type definitions
 */

export interface SigV4Config {
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
  region: string;
  service: string;
}

export interface SignedHeaders {
  [key: string]: string;
}

/**
 * RFC 3986 compliant URI encoding for AWS SigV4
 * AWS requires specific characters to be percent-encoded
 */
function encodeRFC3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

/**
 * Get canonical path with proper encoding for AWS SigV4
 * Based on official AWS SigV4 signing example
 */
function getCanonicalPath(path: string, isS3: boolean = false): string {
  if (!isS3) {
    // Non-S3 services, we normalize the path and then double URI encode it.
    // Ref: "Remove Dot Segments" https://datatracker.ietf.org/doc/html/rfc3986#section-5.2.4
    const normalizedPathSegments: string[] = [];
    for (const pathSegment of path.split("/")) {
      if (pathSegment?.length === 0) continue;
      if (pathSegment === ".") continue;
      if (pathSegment === "..") {
        normalizedPathSegments.pop();
      } else {
        normalizedPathSegments.push(pathSegment);
      }
    }
    // Joining by single slashes to remove consecutive slashes.
    const normalizedPath = `${path?.startsWith("/") ? "/" : ""}${normalizedPathSegments.join("/")}${normalizedPathSegments.length > 0 && path?.endsWith("/") ? "/" : ""}`;
    const doubleEncoded = encodeURIComponent(normalizedPath);
    return doubleEncoded.replace(/%2F/g, "/");
  }
  // For S3, we shouldn't normalize the path. For example, object name
  // my-object//example//photo.user should not be normalized to
  // my-object/example/photo.user
  return path;
}

/**
 * SHA-256 hash using browser's SubtleCrypto
 */
async function sha256(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * HMAC-SHA256 using browser's SubtleCrypto
 */
async function hmacSha256(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const messageBuffer = encoder.encode(message);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, messageBuffer);
}

/**
 * Get signing key for AWS SigV4
 */
async function getSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmacSha256(encoder.encode(`AWS4${secretKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  return kSigning;
}

/**
 * Sign a request with AWS SigV4
 */
export async function signRequestWithSigV4(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: string | undefined,
  config: SigV4Config
): Promise<SignedHeaders> {
  try {
    // Create a date for headers and the credential string
    const date = new Date();
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);

    // Calculate payload hash first
    const payloadHash = await sha256(body || '');

    // Create a clean copy of headers for normalization
    const headersToSign: Record<string, string> = { ...headers };

    // Add required AWS headers
    headersToSign['x-amz-date'] = amzDate;
    headersToSign['x-amz-content-sha256'] = payloadHash;

    // Add session token header if present (required for temporary credentials)
    if (config.sessionToken) {
      headersToSign['x-amz-security-token'] = config.sessionToken;
    }

    // Ensure host header is present
    if (!headersToSign['host'] && url.host) {
      headersToSign['host'] = url.host;
    }

    // Normalize headers (lowercase keys, trim values) - based on official AWS example
    const normalizedHeaders: Record<string, string> = {};
    for (const key in headersToSign) {
      if (headersToSign[key] !== undefined && headersToSign[key] !== null) {
        const normalizedKey = key.toLowerCase();
        const normalizedValue = headersToSign[key].toString().trim();
        normalizedHeaders[normalizedKey] = normalizedValue.replace(/\s+/g, ' ');
      }
    }

    // Create canonical URI with proper encoding
    const canonicalUri = getCanonicalPath(url.pathname || '/', false);

    // Create canonical query string with AWS-compliant sorting
    let canonicalQueryString = '';
    if (url.search) {
      const searchParams = new URLSearchParams(url.search);

      // Use strict ASCII sorting instead of localeCompare for AWS SigV4 compliance
      const sortedParams = Array.from(searchParams.entries())
        .sort(([keyA], [keyB]) => {
          // Strict lexicographic (ASCII) sorting as required by AWS
          if (keyA < keyB) return -1;
          if (keyA > keyB) return 1;
          return 0;
        });

      canonicalQueryString = sortedParams
        .map(([key, value]) => {
          // Use RFC 3986 encoding to match what we use in the actual request
          const encodedKey = encodeRFC3986(key);
          const encodedValue = encodeRFC3986(value);
          // Do not log query param keys/values or the canonical query string:
          // signed URLs can carry tokens/credentials in their parameters.
          return `${encodedKey}=${encodedValue}`;
        })
        .join('&');
    }

    // Create canonical headers
    const canonicalHeadersList = Object.entries(normalizedHeaders)
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
      .map(([key, value]) => `${key}:${value}\n`);

    const canonicalHeaders = canonicalHeadersList.join('');

    // Create signed headers string
    const signedHeaders = Object.keys(normalizedHeaders)
      .sort()
      .join(';');

    // Create canonical request
    const canonicalRequest = [
      method.toUpperCase(),
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');

    // Create string to sign
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = [
      dateStamp,
      config.region,
      config.service,
      'aws4_request'
    ].join('/');

    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      await sha256(canonicalRequest)
    ].join('\n');

    // Calculate signature
    const signingKey = await getSigningKey(config.secretKey, dateStamp, config.region, config.service);
    const signature = Array.from(new Uint8Array(
      await hmacSha256(signingKey, stringToSign)
    ))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Create authorization header
    const authorizationHeader = [
      `${algorithm} Credential=${config.accessKey}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`
    ].join(', ');

    // Create final headers as a new object with string keys and values
    const result: SignedHeaders = {};

    // Copy original headers
    for (const key in headers) {
      result[key] = headers[key];
    }

    // Add AWS specific headers
    result['x-amz-date'] = amzDate;
    result['x-amz-content-sha256'] = payloadHash;
    result['Authorization'] = authorizationHeader;

    // Add session token header if present (required for temporary credentials)
    if (config.sessionToken) {
      result['x-amz-security-token'] = config.sessionToken;
    }

    // Ensure host header is present
    if (!result['host'] && url.host) {
      result['host'] = url.host;
    }

    return result;

  } catch (error) {
    console.error('Error in signRequestWithSigV4:', error.message);
    throw error;
  }
}
