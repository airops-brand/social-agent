const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} = require('@modelcontextprotocol/client');

const ORDINAL_MCP_URL = 'https://app.tryordinal.com/mcp';

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function secureEqual(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class EncryptedJsonStore {
  constructor(filePath, encryptionKey) {
    this.filePath = filePath;
    this.key = encryptionKey ? Buffer.from(encryptionKey, 'base64') : null;
    if (this.key && this.key.length !== 32) {
      throw new Error('ORDINAL_OAUTH_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    }
  }

  isConfigured() {
    return Boolean(this.filePath && this.key);
  }

  read() {
    if (!this.isConfigured() || !fs.existsSync(this.filePath)) return {};

    const envelope = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (envelope.version !== 1) throw new Error('Unsupported Ordinal OAuth credential format');

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  }

  write(value) {
    if (!this.isConfigured()) {
      throw new Error('Ordinal OAuth credential storage is not configured');
    }

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    const envelope = {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };

    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }

  update(updater) {
    const value = this.read();
    updater(value);
    this.write(value);
    return value;
  }
}

class RailwayOAuthProvider {
  constructor(store, redirectUrl) {
    this.store = store;
    this.redirectUrlValue = redirectUrl;
    this.authorizationUrl = null;
  }

  get redirectUrl() {
    return this.redirectUrlValue;
  }

  get clientMetadata() {
    return {
      client_name: 'Edna Social Agent',
      redirect_uris: [this.redirectUrlValue],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  beginAuthorization() {
    const oauthState = crypto.randomBytes(32).toString('base64url');
    this.authorizationUrl = null;
    this.store.update((value) => {
      value.oauthState = oauthState;
      delete value.tokens;
      delete value.codeVerifier;
      delete value.discoveryState;
    });
    return oauthState;
  }

  state() {
    return this.store.read().oauthState;
  }

  clientInformation() {
    return this.store.read().clientInformation;
  }

  saveClientInformation(clientInformation) {
    this.store.update((value) => { value.clientInformation = clientInformation; });
  }

  tokens() {
    return this.store.read().tokens;
  }

  saveTokens(tokens) {
    this.store.update((value) => { value.tokens = tokens; });
  }

  redirectToAuthorization(authorizationUrl) {
    this.authorizationUrl = authorizationUrl.toString();
  }

  saveCodeVerifier(codeVerifier) {
    this.store.update((value) => { value.codeVerifier = codeVerifier; });
  }

  codeVerifier() {
    const verifier = this.store.read().codeVerifier;
    if (!verifier) throw new Error('Missing Ordinal OAuth PKCE verifier');
    return verifier;
  }

  saveDiscoveryState(discoveryState) {
    this.store.update((value) => { value.discoveryState = discoveryState; });
  }

  discoveryState() {
    return this.store.read().discoveryState;
  }

  saveResourceUrl(resourceUrl) {
    this.store.update((value) => { value.resourceUrl = resourceUrl; });
  }

  resourceUrl() {
    return this.store.read().resourceUrl;
  }

  invalidateCredentials(scope) {
    this.store.update((value) => {
      if (scope === 'all' || scope === 'tokens') delete value.tokens;
      if (scope === 'all' || scope === 'client') delete value.clientInformation;
      if (scope === 'all' || scope === 'verifier') delete value.codeVerifier;
      if (scope === 'all' || scope === 'discovery') delete value.discoveryState;
    });
  }
}

function parseToolResult(result) {
  const text = (result.content || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
    .trim();

  if (result.isError) {
    throw new Error(text || 'Ordinal returned a tool error');
  }

  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!text) return result;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class OrdinalMcpIntegration {
  constructor(options = {}) {
    const baseUrl = options.baseUrl || process.env.ORDINAL_OAUTH_BASE_URL || (
      process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''
    );
    const stateDirectory = options.stateDirectory || process.env.STATE_DIR || '/data';
    const credentialPath = options.credentialPath
      || process.env.ORDINAL_OAUTH_STORE
      || path.join(stateDirectory, 'ordinal-oauth.enc.json');

    this.mcpUrl = options.mcpUrl || ORDINAL_MCP_URL;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.setupToken = options.setupToken || process.env.ORDINAL_OAUTH_SETUP_TOKEN || '';
    this.store = new EncryptedJsonStore(
      credentialPath,
      options.encryptionKey || process.env.ORDINAL_OAUTH_ENCRYPTION_KEY || '',
    );
    this.provider = new RailwayOAuthProvider(
      this.store,
      `${this.baseUrl}/ordinal/oauth/callback`,
    );
    this.clientPromise = null;
    this.server = null;
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.store.isConfigured());
  }

  isAuthorized() {
    try {
      return Boolean(this.store.read().tokens);
    } catch {
      return false;
    }
  }

  async createConnectedClient() {
    if (!this.isConfigured()) {
      throw new Error('Ordinal OAuth is not configured in Railway');
    }

    const client = new Client({ name: 'edna-social-agent', version: '2.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), {
      authProvider: this.provider,
    });
    await client.connect(transport);
    return client;
  }

  getClient() {
    if (!this.clientPromise) {
      this.clientPromise = this.createConnectedClient().catch((error) => {
        this.clientPromise = null;
        throw error;
      });
    }
    return this.clientPromise;
  }

  resetClient() {
    this.clientPromise = null;
  }

  async callTool(name, args) {
    if (!this.isAuthorized()) {
      throw new Error('Ordinal OAuth authorization is required');
    }

    try {
      const client = await this.getClient();
      const result = await client.callTool({ name, arguments: args });
      return parseToolResult(result);
    } catch (error) {
      this.resetClient();
      throw new Error(`Ordinal ${name} failed: ${error.message}`);
    }
  }

  async listTools() {
    if (!this.isAuthorized()) {
      throw new Error('Ordinal OAuth authorization is required');
    }

    try {
      const client = await this.getClient();
      const result = await client.listTools();
      return result.tools || [];
    } catch (error) {
      this.resetClient();
      throw new Error(`Ordinal tool discovery failed: ${error.message}`);
    }
  }

  async beginOAuth() {
    if (!this.isConfigured()) throw new Error('Ordinal OAuth is not configured in Railway');
    this.provider.beginAuthorization();
    this.resetClient();

    try {
      await this.getClient();
      return null;
    } catch (error) {
      if (!(error instanceof UnauthorizedError) && !this.provider.authorizationUrl) throw error;
      return this.provider.authorizationUrl;
    }
  }

  async finishOAuth(searchParams) {
    const expectedState = this.provider.state();
    if (!expectedState || !secureEqual(searchParams.get('state'), expectedState)) {
      throw new Error('Invalid or expired OAuth state');
    }

    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), {
      authProvider: this.provider,
    });
    await transport.finishAuth(searchParams);
    this.resetClient();
    const client = await this.getClient();
    const workspaceResult = await client.callTool({
      name: 'ordinal_get_workspace_context',
      arguments: {},
    });
    return parseToolResult(workspaceResult);
  }

  startHttpServer(port = Number(process.env.PORT || 3000)) {
    if (this.server) return this.server;

    this.server = http.createServer(async (request, response) => {
      const origin = this.baseUrl || `http://${request.headers.host}`;
      const url = new URL(request.url, origin);
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Cache-Control', 'no-store');

      if (url.pathname === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          ok: true,
          ordinalConfigured: this.isConfigured(),
          ordinalAuthorized: this.isAuthorized(),
        }));
        return;
      }

      if (url.pathname === '/ordinal/oauth/start') {
        if (!this.setupToken || !secureEqual(url.searchParams.get('token'), this.setupToken)) {
          response.writeHead(404, { 'Content-Type': 'text/plain' });
          response.end('Not found');
          return;
        }

        try {
          const authorizationUrl = await this.beginOAuth();
          if (!authorizationUrl) {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end('<h1>Ordinal is already connected</h1>');
            return;
          }
          response.writeHead(302, { Location: authorizationUrl });
          response.end();
        } catch (error) {
          console.error('[ordinal-oauth] Failed to begin authorization:', error.message);
          response.writeHead(500, { 'Content-Type': 'text/plain' });
          response.end('Could not begin Ordinal authorization. Check Railway logs.');
        }
        return;
      }

      if (url.pathname === '/ordinal/oauth/callback') {
        try {
          const workspaces = await this.finishOAuth(url.searchParams);
          console.log('[ordinal-oauth] Ordinal authorization completed successfully');
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(
            '<h1>Ordinal connected to Edna</h1>'
            + '<p>You can close this window.</p>'
            + `<pre>${htmlEscape(JSON.stringify(workspaces, null, 2))}</pre>`,
          );
        } catch (error) {
          console.error('[ordinal-oauth] Callback failed:', error.message);
          response.writeHead(400, { 'Content-Type': 'text/plain' });
          response.end('Ordinal authorization failed. Check Railway logs and try again.');
        }
        return;
      }

      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not found');
    });

    this.server.listen(port, '0.0.0.0', () => {
      console.log(`[startup] Health and Ordinal OAuth server listening on port ${port}`);
    });
    return this.server;
  }
}

module.exports = {
  EncryptedJsonStore,
  OrdinalMcpIntegration,
  RailwayOAuthProvider,
  parseToolResult,
};
