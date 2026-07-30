/**
 * Vercel's zero-configuration Express entry point.
 */

import express from 'express';
import gameApp from './server/server.js';

const app = express();
app.use(gameApp);

export default app;
