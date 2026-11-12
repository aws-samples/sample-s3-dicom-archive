/**
 * @typedef {Object} SigV4Config
 * @property {string} accessKey - AWS access key
 * @property {string} secretKey - AWS secret key
 * @property {string} [sessionToken] - Optional AWS session token
 * @property {string} region - AWS region
 * @property {string} service - AWS service name
 */

/**
 * RFC 3986 compliant URI encoding for AWS SigV4
 * AWS requires specific characters to be percent-encoded
 * @param {string} str - String to encode
 * @returns {string} - RFC 3986 encoded string
 */
function encodeRFC3986(str) {
    return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
        return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
}

/**
 * Get canonical path with proper encoding for AWS SigV4
 * Based on official AWS SigV4 signing example
 * @param {string} path - The URL path
 * @param {boolean} isS3 - Whether this is for S3 service
 * @returns {string} - Properly encoded canonical path
 */
function getCanonicalPath(path, isS3) {
    if (!isS3) {
        // Non-S3 services, we normalize the path and then double URI encode it.
        // Ref: "Remove Dot Segments" https://datatracker.ietf.org/doc/html/rfc3986#section-5.2.4
        const normalizedPathSegments = [];
        for (const pathSegment of path.split("/")) {
            if (pathSegment?.length === 0)
                continue;
            if (pathSegment === ".")
                continue;
            if (pathSegment === "..") {
                normalizedPathSegments.pop();
            }
            else {
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
 * @param {string} message - Message to hash
 * @returns {Promise<string>} - Hex string of hash
 */
async function sha256(message) {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
}

/**
 * HMAC-SHA256 using browser's SubtleCrypto
 * @param {ArrayBuffer} key - Key for HMAC
 * @param {string} message - Message to sign
 * @returns {Promise<ArrayBuffer>} - Signed message
 */
async function hmacSha256(key, message) {
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
 * @param {string} secretKey - AWS secret key
 * @param {string} dateStamp - Date in YYYYMMDD format
 * @param {string} region - AWS region
 * @param {string} service - AWS service
 * @returns {Promise<ArrayBuffer>} - Signing key
 */
async function getSigningKey(secretKey, dateStamp, region, service) {
    const encoder = new TextEncoder();
    const kDate = await hmacSha256(encoder.encode(`AWS4${secretKey}`), dateStamp);
    const kRegion = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, service);
    const kSigning = await hmacSha256(kService, 'aws4_request');
    return kSigning;
}

/**
 * Sign a request with AWS SigV4
 * @param {string} method - HTTP method
 * @param {URL} url - Request URL
 * @param {Object} headers - Request headers
 * @param {string|undefined} body - Request body
 * @param {SigV4Config} config - AWS SigV4 configuration
 * @returns {Promise<Object>} - Signed headers
 */
export async function signRequestWithSigV4(method, url, headers, body, config) {
  try {
      // console.log('Signing request with SigV4...');
      // console.log('Method:', method);
      // console.log('URL:', url.toString());
      // console.log('Original headers:', headers);
      // console.log('Config:', config);

      // Create a date for headers and the credential string
      const date = new Date();
      const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
      const dateStamp = amzDate.substring(0, 8);

      // Calculate payload hash first
      const payloadHash = await sha256(body || '');

      // Create a clean copy of headers for normalization
      const headersToSign = { ...headers };


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
      const normalizedHeaders = {};
      for (const key in headersToSign) {
        if (headersToSign[key] !== undefined && headersToSign[key] !== null) {
          const normalizedKey = key.toLowerCase();
          const normalizedValue = headersToSign[key].toString().trim(); // Explicit trim like official example
          normalizedHeaders[normalizedKey] = normalizedValue.replace(/\s+/g, ' ');
        }
      }

      // console.log('Normalized headers:', normalizedHeaders);

      // Create canonical URI with proper encoding (based on official AWS example)
      const canonicalUri = getCanonicalPath(url.pathname || '/', false); // false = not S3 service
      // console.log('Original pathname:', url.pathname);
      // console.log('Canonical URI after encoding:', canonicalUri);
      // console.log('=== URL CASE SENSITIVITY DEBUG ===');
      // console.log('Original URL:', url.toString());
      // console.log('URL pathname (canonical URI):', canonicalUri);
      // console.log('URL search (query string):', url.search);

      // Create canonical query string with AWS-compliant sorting
      let canonicalQueryString = '';
      if (url.search) {
        // console.log('Processing query parameters...');
        // Remove the leading '?' and split into key-value pairs
        const searchParams = new URLSearchParams(url.search);

        // Log original query parameters before processing
        // console.log('Original query parameters:');
        // for (const [key, value] of searchParams.entries()) {
        //   console.log(`  "${key}" = "${value}"`);
        // }

        // Use strict ASCII sorting instead of localeCompare for AWS SigV4 compliance
        const sortedParams = Array.from(searchParams.entries())
          .sort(([keyA], [keyB]) => {
            // Strict lexicographic (ASCII) sorting as required by AWS
            if (keyA < keyB) return -1;
            if (keyA > keyB) return 1;
            return 0;
          });

        // console.log('After strict ASCII sorting:');
        // sortedParams.forEach(([key, value]) => {
        //   console.log(`  "${key}" = "${value}"`);
        // });

        canonicalQueryString = sortedParams
          .map(([key, value]) => {
            const encodedKey = encodeRFC3986(key);
            const encodedValue = encodeRFC3986(value);
            // Do not log query param keys/values (signed URLs can carry tokens).
            return `${encodedKey}=${encodedValue}`;
          })
          .join('&');
      }

      // console.log('Final canonical query string:', canonicalQueryString);
      // console.log('=== END URL CASE SENSITIVITY DEBUG ===');

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

      // console.log('=== CANONICAL REQUEST CONSTRUCTION ===');
      // console.log('HTTP Method:', method.toUpperCase());
      // console.log('Canonical URI:', `"${canonicalUri}"`);
      // console.log('Canonical Query String:', `"${canonicalQueryString}"`);
      // console.log('Canonical Headers:');
      // console.log(canonicalHeaders);
      // console.log('Signed Headers:', signedHeaders);
      // console.log('Payload Hash:', payloadHash);
      // console.log('Complete Canonical Request:');
      // console.log('---START---');
      // console.log(canonicalRequest);
      // console.log('---END---');
      // console.log('=== END CANONICAL REQUEST CONSTRUCTION ===');

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

      // console.log('String to Sign:', stringToSign);

      // Calculate signature
      const signingKey = await getSigningKey(config.secretKey, dateStamp, config.region, config.service);
      const signature = Array.from(new Uint8Array(
        await hmacSha256(signingKey, stringToSign)
      ))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      // console.log('Signature:', signature);

      // Create authorization header
      const authorizationHeader = [
        `${algorithm} Credential=${config.accessKey}/${credentialScope}`,
        `SignedHeaders=${signedHeaders}`,
        `Signature=${signature}`
      ].join(', ');

      // console.log('Generated Authorization header:', authorizationHeader);

      // Create final headers as a new object with string keys and values
      const result = {};

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

      // console.log('Final Headers:', result);

      // // Log the Authorization header specifically for debugging
      // console.log('AUTH HEADER CHECK: Is Authorization present?', 'Authorization' in result);
      // console.log('AUTH HEADER CHECK: Authorization value:', result['Authorization']);

      return result;

    } catch (error) {
      console.error('Error in signRequest:', error.message);
      throw error;
    }
}
