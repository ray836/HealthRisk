/**
 * Permanent-process entry point for local development and traditional hosts.
 * Vercel imports the Express app from ../server.ts instead.
 */

import { startLocalServer } from './server.js';

startLocalServer().catch((error: unknown) => {
  console.error('Failed to start:', error);
  process.exitCode = 1;
});
