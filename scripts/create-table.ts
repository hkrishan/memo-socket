/**
 * Creates the chat messages DynamoDB table (idempotent — skips when the
 * table already exists). Run with: npm run db:create-table
 *
 * Targets DYNAMO_ENDPOINT when set (dynamodb-local), otherwise real AWS in
 * AWS_REGION using explicit env credentials or the SDK default chain.
 */
import 'dotenv/config';
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';

const region = process.env.AWS_REGION || 'eu-north-1';
const tableName = process.env.DYNAMO_TABLE || 'memo-chat-messages';
const endpoint = process.env.DYNAMO_ENDPOINT;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

const client = new DynamoDBClient({
  region,
  ...(endpoint ? { endpoint } : {}),
  ...(accessKeyId && secretAccessKey
    ? { credentials: { accessKeyId, secretAccessKey } }
    : {}),
});

const main = async () => {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    console.log(`Table "${tableName}" already exists — nothing to do.`);
    return;
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }

  console.log(`Creating table "${tableName}" (${endpoint ?? `AWS ${region}`})...`);
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'albumId', AttributeType: 'S' },
        { AttributeName: 'messageId', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'albumId', KeyType: 'HASH' },
        { AttributeName: 'messageId', KeyType: 'RANGE' },
      ],
    }),
  );

  await waitUntilTableExists(
    { client, maxWaitTime: 120 },
    { TableName: tableName },
  );
  console.log(`Table "${tableName}" created.`);
};

main().catch((error) => {
  console.error('create-table failed:', error);
  process.exit(1);
});
