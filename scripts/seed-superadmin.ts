/**
 * Seed script — creates the first SUPERADMIN user.
 *
 * Usage:
 *   pnpm seed:superadmin
 *
 * Prompts for password interactively (hidden input). Bcrypt-hashes and
 * inserts the user. Aborts if a SUPERADMIN already exists for the email.
 *
 * Environment overrides:
 *   SUPERADMIN_EMAIL     — defaults to foongef@gmail.com
 *   SUPERADMIN_PASSWORD  — when set, skips the interactive prompt (for CI/scripts)
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as readline from 'readline';
import { Writable } from 'stream';

const DEFAULT_EMAIL = 'foongef@gmail.com';

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const muted = new Writable({
      write(chunk, _enc, cb) {
        if (process.env.DEBUG_PROMPT) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = readline.createInterface({
      input: process.stdin,
      output: muted,
      terminal: true,
    });
    process.stdout.write(question);
    rl.question('', (answer: string) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const email = (process.env.SUPERADMIN_EMAIL || DEFAULT_EMAIL).toLowerCase();
  const prisma = new PrismaClient();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`✓ User already exists: ${email} (role=${existing.role}). Aborting.`);
    await prisma.$disconnect();
    return;
  }

  const password = process.env.SUPERADMIN_PASSWORD ?? (await promptHidden(`Password for ${email}: `));
  if (password.length < 8) {
    console.error('✗ Password must be at least 8 characters.');
    await prisma.$disconnect();
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: 'SUPERADMIN',
      isActive: true,
    },
  });

  console.log(`✓ Created SUPERADMIN: ${user.email} (id=${user.id})`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
