import * as crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const hex = config.get<string>('BROKER_CREDS_KEY');
    if (!hex) {
      throw new Error('BROKER_CREDS_KEY env var is required. Generate via: openssl rand -hex 32');
    }
    if (hex.length !== 64) {
      throw new Error('BROKER_CREDS_KEY must be 32 bytes (64 hex chars). Got length ' + hex.length);
    }
    this.key = Buffer.from(hex, 'hex');
  }

  encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag() };
  }

  decrypt(ciphertext: Buffer, iv: Buffer, authTag: Buffer): string {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
