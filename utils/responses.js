// Success Responses
const successResponse = (res, message, data = null) => {
  return res.status(200).json({
    status: 200,
    success: true,
    message,
    ...(data && { data })
  });
};

const createdResponse = (res, message, data = null) => {
  return res.status(201).json({
    status: 201,
    success: true,
    message,
    ...(data && { data })
  });
};

// Error Responses
const badRequestResponse = (res, message) => {
  return res.status(400).json({
    status: 400,
    success: false,
    message
  });
};

const unauthorizedResponse = (res, message = 'Unauthorized access') => {
  return res.status(401).json({
    status: 401,
    success: false,
    message
  });
};

const forbiddenResponse = (res, message = 'Forbidden access') => {
  return res.status(403).json({
    status: 403,
    success: false,
    message
  });
};

const notFoundResponse = (res, message = 'Resource not found') => {
  return res.status(404).json({
    status: 404,
    success: false,
    message
  });
};

const conflictResponse = (res, message) => {
  return res.status(409).json({
    status: 409,
    success: false,
    message
  });
};

const validationErrorResponse = (res, message, errors) => {
  return res.status(422).json({
    status: 422,
    success: false,
    message,
    errors
  });
};

const serverErrorResponse = (res, message = 'Internal server error') => {
  return res.status(500).json({
    status: 500,
    success: false,
    message
  });
};

export {
  // Success responses
  successResponse,
  createdResponse,

  // Error responses
  badRequestResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  conflictResponse,
  validationErrorResponse,
  serverErrorResponse
};
