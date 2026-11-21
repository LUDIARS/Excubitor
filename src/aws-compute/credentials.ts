import { createHash } from 'node:crypto';
import type { Vault } from '../vault/vault.js';
import { AwsProtocol, type AwsTransport } from './aws-protocol.js';
import { child, value } from './aws-xml.js';
import type { AwsCredentials } from './sigv4.js';

export const AWS_VAULT_KEYS = {
  access: 'EX_AWS_COMPUTE_ACCESS_KEY_ID',
  secretKey: 'EX_AWS_COMPUTE_SECRET_ACCESS_KEY',
  role: 'EX_AWS_COMPUTE_ROLE_ARN',
  sessionToken: 'EX_AWS_COMPUTE_SESSION_TOKEN',
  external: 'EX_AWS_COMPUTE_EXTERNAL_ID',
} as const;

interface CredentialConfig {
  base: AwsCredentials;
  role?: string;
  externalId?: string;
}

export class CredentialsUnavailable extends Error {
  constructor() { super('credentials_unavailable'); }
}

/** Ex resolves these shared Vault values internally. No SDK credential chain or env fallback. */
export class AwsCredentialSource {
  private fingerprint: string | undefined;
  private readonly sessions = new Map<string, { credentials: AwsCredentials; expires: number }>();

  constructor(
    private readonly vault: Pick<Vault, 'valuesOf'>,
    private readonly transport?: AwsTransport,
    private readonly now: () => number = Date.now,
  ) {}

  async readiness(): Promise<{ configured: boolean }> {
    try {
      await this.readConfig();
      return { configured: true };
    } catch {
      // Readiness exposes only local Vault configuration, never AWS error details.
      return { configured: false };
    }
  }

  async protocol(region: string): Promise<AwsProtocol> {
    try {
      const config = await this.readConfig();
      const fingerprint = createHash('sha256').update(JSON.stringify(config)).digest('hex');
      if (fingerprint !== this.fingerprint) {
        this.sessions.clear();
        this.fingerprint = fingerprint;
      }
      const credentials = config.role ? await this.assumeRole(region, config, config.role) : config.base;
      return new AwsProtocol(region, credentials, this.transport, this.now);
    } catch {
      // A Vault or STS failure must never reach HTTP responses or logs with its underlying details.
      throw new CredentialsUnavailable();
    }
  }

  private async readConfig(): Promise<CredentialConfig> {
    const stored = await this.vault.valuesOf(Object.values(AWS_VAULT_KEYS));
    const accessKeyId = stored[AWS_VAULT_KEYS.access];
    const secretAccessKey = stored[AWS_VAULT_KEYS.secretKey];
    const role = stored[AWS_VAULT_KEYS.role];
    const sessionToken = stored[AWS_VAULT_KEYS.sessionToken];
    const externalId = stored[AWS_VAULT_KEYS.external];
    if (!accessKeyId || !/^[A-Z0-9]{16,128}$/.test(accessKeyId)
      || !secretAccessKey || !/^[A-Za-z0-9/+=]{16,128}$/.test(secretAccessKey)
      || (accessKeyId.startsWith('ASIA') && !sessionToken)
      || (sessionToken !== undefined && !/^[\x21-\x7e]{1,8192}$/.test(sessionToken))
      || (role !== undefined && !/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/.test(role))
      || (externalId !== undefined && (!role || !/^[A-Za-z0-9_+=,.@:/-]{2,1224}$/.test(externalId)))) {
      throw new CredentialsUnavailable();
    }
    return { base: { accessKeyId, secretAccessKey, sessionToken }, role, externalId };
  }

  private async assumeRole(region: string, config: CredentialConfig, role: string): Promise<AwsCredentials> {
    const cached = this.sessions.get(region);
    if (cached && cached.expires > this.now() + 60_000) return cached.credentials;

    const sts = new AwsProtocol(region, config.base, this.transport, this.now);
    const response = await sts.query('sts', 'AssumeRole', {
      RoleArn: role, RoleSessionName: 'ExcubitorAwsCompute', DurationSeconds: 900,
      ...(config.externalId ? { ExternalId: config.externalId } : {}),
    });
    const values = child(child(response, 'AssumeRoleResult'), 'Credentials');
    const accessKeyId = value(values, 'AccessKeyId');
    const secretAccessKey = value(values, 'SecretAccessKey');
    const sessionToken = value(values, 'SessionToken');
    const expires = Date.parse(value(values, 'Expiration') ?? '');
    if (!accessKeyId || !secretAccessKey || !sessionToken || !Number.isFinite(expires) || expires <= this.now()) {
      throw new CredentialsUnavailable();
    }
    const credentials = { accessKeyId, secretAccessKey, sessionToken };
    this.sessions.set(region, { credentials, expires });
    return credentials;
  }
}
