import { onRequest } from 'firebase-functions/v2/https';
import { commerceHttp } from './commerce-functions.mjs';

export const commerce = onRequest({ cors: false, concurrency: 16, maxInstances: 2, timeoutSeconds: 60 }, commerceHttp);
