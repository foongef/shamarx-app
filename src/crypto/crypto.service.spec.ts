import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from './crypto.service';

describe('CryptoService', () => {
  const validKey = 'a'.repeat(64); // 32 bytes hex
  let service: CryptoService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CryptoService,
        { provide: ConfigService, useValue: { get: () => validKey } },
      ],
    }).compile();
    service = moduleRef.get(CryptoService);
  });

  it('round-trips plaintext through encrypt + decrypt', () => {
    const plaintext = JSON.stringify({ accountId: 'abc', accessToken: 'secret-xyz' });
    const { ciphertext, iv, authTag } = service.encrypt(plaintext);
    expect(ciphertext.byteLength).toBeGreaterThan(0);
    expect(iv.byteLength).toBe(12);
    expect(authTag.byteLength).toBe(16);
    expect(service.decrypt(ciphertext, iv, authTag)).toBe(plaintext);
  });

  it('produces a different IV on each encryption', () => {
    const a = service.encrypt('same plaintext');
    const b = service.encrypt('same plaintext');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('decryption with a tampered authTag throws', () => {
    const { ciphertext, iv, authTag } = service.encrypt('hello');
    const tampered = Buffer.from(authTag);
    tampered[0] = tampered[0] ^ 0xff;
    expect(() => service.decrypt(ciphertext, iv, tampered)).toThrow();
  });

  it('rejects construction when BROKER_CREDS_KEY is missing', async () => {
    await expect(
      Test.createTestingModule({
        providers: [
          CryptoService,
          { provide: ConfigService, useValue: { get: () => undefined } },
        ],
      }).compile(),
    ).rejects.toThrow(/BROKER_CREDS_KEY/);
  });

  it('rejects construction when BROKER_CREDS_KEY is wrong length', async () => {
    await expect(
      Test.createTestingModule({
        providers: [
          CryptoService,
          { provide: ConfigService, useValue: { get: () => 'short' } },
        ],
      }).compile(),
    ).rejects.toThrow(/64 hex chars/);
  });
});
