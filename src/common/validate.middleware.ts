import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { createLogger } from './logger.js';

const log = createLogger('validate');

/**
 * Express middleware to validate request body against a Zod schema.
 */
export const validateBody = (schema: ZodSchema) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      req.body = await schema.parseAsync(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        log.warn(`Validation failed on ${req.method} ${req.originalUrl}: ${error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        res.status(400).json({
          error: 'Validation failed',
          issues: error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message
          }))
        });
        return;
      }
      log.error('Unexpected validation error', error);
      res.status(400).json({ error: 'Invalid request payload' });
    }
  };
};
