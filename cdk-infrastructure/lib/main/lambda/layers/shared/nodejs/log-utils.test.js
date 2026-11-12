const { sanitizeError } = require('./log-utils');

describe('sanitizeError', () => {
  test('extracts only safe fields from an Error with extra/sensitive props', () => {
    const err = new Error('Connection failed for patient PID-12345');
    err.code = 'ECONNREFUSED';
    err.statusCode = 500;
    err.requestBody = { patientId: 'PID-12345', ssn: '000-00-0000' }; // sensitive

    const result = sanitizeError(err);

    expect(result).toEqual({
      message: 'Connection failed for patient PID-12345',
      name: 'Error',
      code: 'ECONNREFUSED',
      statusCode: 500,
    });
    // The sensitive payload must not survive sanitization.
    expect(result.requestBody).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('000-00-0000');
  });

  test('handles a plain string error', () => {
    expect(sanitizeError('boom')).toEqual({ message: 'boom' });
  });

  test('handles null and undefined', () => {
    expect(sanitizeError(null)).toEqual({ message: 'null' });
    expect(sanitizeError(undefined)).toEqual({ message: 'undefined' });
  });

  test('omits absent optional fields', () => {
    expect(sanitizeError(new Error('simple'))).toEqual({
      message: 'simple',
      name: 'Error',
    });
  });
});
