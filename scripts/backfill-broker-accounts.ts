/**
 * One-shot backfill: turns the env-driven MetaApi account into a
 * BrokerAccount row, and assigns existing Trade / LiveSession /
 * EquitySnapshot / RiskState rows to it.
 *
 * Idempotent — re-running skips already-assigned rows and updates the
 * BrokerAccount row in place.
 *
 * Requires BROKER_CREDS_KEY in env. Generate one via: openssl rand -hex 32
 *
 * Run via: pnpm ts-node -P tsconfig.build.json --transpile-only scripts/backfill-broker-accounts.ts
 */
import { PrismaClient } from '@prisma/client';
import * as crypto from 'node:crypto';

const DEFAULT_NAME = process.env.BACKFILL_ACCOUNT_NAME || 'Pepperstone Demo';

async function loadMasterKey(): Promise<string> {
  const secretId = process.env.BROKER_CREDS_SECRET_ID;
  const envKey = process.env.BROKER_CREDS_KEY;
  if (secretId) {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const region = process.env.AWS_REGION || 'ap-southeast-5';
    const client = new SecretsManagerClient({ region });
    try {
      const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (!res.SecretString) throw new Error(`Secrets Manager returned no SecretString for ${secretId}`);
      return res.SecretString.trim();
    } finally {
      client.destroy();
    }
  }
  if (envKey) return envKey;
  throw new Error('Neither BROKER_CREDS_SECRET_ID nor BROKER_CREDS_KEY is set');
}

async function main() {
  const key = await loadMasterKey();
  if (key.length !== 64) {
    throw new Error('Master key must be 32 bytes (64 hex chars)');
  }
  const accountId = process.env.METAAPI_ACCOUNT_ID_DEMO;
  const accessToken = process.env.METAAPI_ACCESS_TOKEN;
  if (!accountId || !accessToken) {
    throw new Error('METAAPI_ACCOUNT_ID_DEMO and METAAPI_ACCESS_TOKEN must be set');
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!user) throw new Error('No User row found — bootstrap a user first');

    // Encrypt creds.
    const credsJson = JSON.stringify({ accountId, accessToken });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    const ciphertext = Buffer.concat([cipher.update(credsJson, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Upsert account by (userId, name) unique key.
    const existing = await prisma.brokerAccount.findUnique({
      where: { userId_name: { userId: user.id, name: DEFAULT_NAME } },
    });
    const account = existing
      ? await prisma.brokerAccount.update({
          where: { id: existing.id },
          data: {
            encryptedCreds: ciphertext,
            credsIv: iv,
            credsAuthTag: authTag,
            mode: 'metaapi',
            broker: 'METAAPI',
            isEnabled: existing.isEnabled,
          } as any,
        })
      : await prisma.brokerAccount.create({
          data: {
            userId: user.id,
            name: DEFAULT_NAME,
            broker: 'METAAPI',
            mode: 'metaapi',
            isEnabled: true,
            encryptedCreds: ciphertext,
            credsIv: iv,
            credsAuthTag: authTag,
          } as any,
        });

    console.log(`BrokerAccount ${existing ? 'updated' : 'created'}: ${account.id}`);

    const tradeCount = await prisma.trade.updateMany({
      where: { accountId: null },
      data: { accountId: account.id },
    });
    console.log(`Backfilled ${tradeCount.count} Trade row(s).`);

    const sessionCount = await prisma.liveSession.updateMany({
      where: { accountId: null },
      data: { accountId: account.id },
    });
    console.log(`Backfilled ${sessionCount.count} LiveSession row(s).`);

    const equityCount = await prisma.equitySnapshot.updateMany({
      where: { accountId: null },
      data: { accountId: account.id },
    });
    console.log(`Backfilled ${equityCount.count} EquitySnapshot row(s).`);

    const riskCount = await prisma.riskState.updateMany({
      where: { accountId: null },
      data: { accountId: account.id },
    });
    console.log(`Backfilled ${riskCount.count} RiskState row(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
