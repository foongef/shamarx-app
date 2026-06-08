import * as crypto from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * CryptoService — AES-256-GCM encrypt/decrypt for broker credentials at rest.
 *
 * Master key source (in priority order):
 *   1. BROKER_CREDS_SECRET_ID env → fetch from AWS Secrets Manager (production)
 *   2. BROKER_CREDS_KEY env → use directly (local dev path)
 *
 * The key is fetched once at boot (OnModuleInit), cached in memory, and used
 * for all subsequent encrypt/decrypt calls. No AWS API call per trade.
 *
 * If neither env is set, init throws. Same for malformed key value.
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);
  private key: Buffer | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const secretId = this.config.get<string>('BROKER_CREDS_SECRET_ID');
    const envKey = this.config.get<string>('BROKER_CREDS_KEY');

    if (secretId) {
      this.key = await this.fetchFromSecretsManager(secretId);
      this.logger.log(`CryptoService: master key loaded from AWS Secrets Manager (${secretId})`);
      return;
    }
    if (envKey) {
      this.key = this.parseHexKey(envKey, 'BROKER_CREDS_KEY');
      this.logger.log('CryptoService: master key loaded from env (local dev path)');
      return;
    }
    throw new Error(
      'CryptoService init failed: neither BROKER_CREDS_SECRET_ID nor BROKER_CREDS_KEY is set',
    );
  }

  private async fetchFromSecretsManager(secretId: string): Promise<Buffer> {
    const region = this.config.get<string>('AWS_REGION') || 'ap-southeast-5';
    const client = new SecretsManagerClient({ region });
    try {
      const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      const raw = res.SecretString;
      if (!raw) {
        throw new Error(`Secrets Manager returned no SecretString for ${secretId}`);
      }
      return this.parseHexKey(raw.trim(), `Secrets Manager secret ${secretId}`);
    } finally {
      client.destroy();
    }
  }

  private parseHexKey(hex: string, source: string): Buffer {
    if (hex.length !== 64) {
      throw new Error(
        `Master key from ${source} must be 32 bytes (64 hex chars). Got length ${hex.length}`,
      );
    }
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error(`Master key from ${source} contains non-hex characters`);
    }
    return Buffer.from(hex, 'hex');
  }

  private ensureReady(): Buffer {
    if (!this.key) {
      throw new Error('CryptoService not initialized — onModuleInit did not run');
    }
    return this.key;
  }

  encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
    const key = this.ensureReady();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag() };
  }

  decrypt(ciphertext: Buffer, iv: Buffer, authTag: Buffer): string {
    const key = this.ensureReady();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
