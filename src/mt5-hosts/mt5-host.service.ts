import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@app/prisma';

export interface Mt5DirectCreds {
  login: string;
  password: string;
  server: string;
}

/**
 * Orchestrates the MT5 Direct host fleet: host selection, terminal
 * provisioning/deprovisioning via the terminal-manager API, and capacity
 * aggregation for the admin dashboard. The manager lives on the Windows
 * host (services/mt5-host/manager.py); we talk to it over the private VPC
 * with a shared-secret header.
 */
@Injectable()
export class Mt5HostService {
  private readonly logger = new Logger(Mt5HostService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private headers() {
    return { 'X-Manager-Secret': this.config.getOrThrow<string>('MT5_MANAGER_SECRET') };
  }

  baseUrl(host: { privateIp: string; port: number }) {
    return `http://${host.privateIp}:${host.port}`;
  }

  /** Least-loaded ACTIVE host with free capacity, or 409. */
  async selectHost() {
    const hosts = await this.prisma.mt5Host.findMany({
      where: { status: 'ACTIVE' },
      include: { _count: { select: { accounts: true } } },
    });
    const candidates = hosts
      .filter((h) => h._count.accounts < h.capacity)
      .sort((a, b) => a._count.accounts - b._count.accounts);
    if (candidates.length === 0) {
      throw new ConflictException(
        'MT5 fleet is full — add capacity before onboarding more accounts',
      );
    }
    return candidates[0];
  }

  /**
   * Provision a terminal for the account. On success stamps hostId +
   * lastConnectedAt. Throws mapped HTTP errors on failure — the CALLER
   * owns row cleanup (fail-clean contract with BrokerAccountsService).
   */
  async provision(accountId: string, creds: Mt5DirectCreds) {
    const host = await this.selectHost();
    try {
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl(host)}/terminals`,
          { accountId, ...creds },
          { headers: this.headers(), timeout: 240_000 },
        ),
      );
      await this.prisma.brokerAccount.update({
        where: { id: accountId },
        data: { hostId: host.id, lastConnectedAt: new Date() },
      });
      this.logger.log(`[${accountId}] terminal provisioned on ${host.name}`);
      return res.data as { status: string; balance?: number; equity?: number };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401) {
        throw new UnauthorizedException('Broker rejected the MT5 login — check credentials');
      }
      if (status === 409) {
        throw new ConflictException('MT5 fleet is full');
      }
      if (err instanceof ConflictException || err instanceof UnauthorizedException) throw err;
      throw new BadGatewayException(`MT5 host provisioning failed: ${err.message}`);
    }
  }

  /** Best-effort terminal teardown — folder cleanup on the host is idempotent. */
  async deprovision(accountId: string) {
    const acct = await this.prisma.brokerAccount.findUnique({
      where: { id: accountId },
      include: { host: true },
    });
    if (!acct?.host) return;
    try {
      await firstValueFrom(
        this.http.delete(`${this.baseUrl(acct.host)}/terminals/${accountId}`, {
          headers: this.headers(),
          timeout: 30_000,
        }),
      );
    } catch (err: any) {
      this.logger.warn(`deprovision ${accountId}: ${err.message} (continuing — idempotent)`);
    }
  }

  /** Per-host capacity snapshots for the admin dashboard + host-stats. */
  async capacities() {
    const hosts = await this.prisma.mt5Host.findMany({ where: { status: { not: 'DOWN' } } });
    return Promise.all(
      hosts.map(async (h) => {
        try {
          const res = await firstValueFrom(
            this.http.get(`${this.baseUrl(h)}/capacity`, {
              headers: this.headers(),
              timeout: 10_000,
            }),
          );
          return { name: h.name, reachable: true, ...res.data };
        } catch {
          return { name: h.name, reachable: false };
        }
      }),
    );
  }
}
