import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.string().default('3031'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  JWT_SECRET: z.string(),
  CACHE_URL: z.string().default('127.0.0.1:6379'),
  CACHE_CLUSTER_MODE: z.enum(['true', 'false']).default('false'),
  CACHE_TLS: z.enum(['true', 'false']).default('false'),
  // memo-api base URL including the /v1 prefix, e.g. http://192.168.1.111:3026/v1
  API_URL: z.string(),
  // Shared secret for internal server-to-server calls (memo-api <-> memo-socket)
  INTERNAL_SECRET: z.string(),
  AWS_REGION: z.string().default('eu-north-1'),
  DYNAMO_TABLE: z.string().default('memo-chat-messages'),
  // Optional — point at dynamodb-local (e.g. http://127.0.0.1:8000) for local dev
  DYNAMO_ENDPOINT: z.string().optional(),
  // Optional — when absent the AWS SDK default credential chain is used
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;

// Weak shared secrets are a silent hole — refuse to boot with them in
// production (dev setups keep whatever they have).
if (env.NODE_ENV === 'production') {
  for (const name of ['JWT_SECRET', 'INTERNAL_SECRET'] as const) {
    if (env[name].length < 32) {
      throw new Error(`${name} must be at least 32 characters in production`);
    }
  }
}
