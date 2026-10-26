import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DockerSandboxManager } from '../../src/sandbox/docker.ts'
import { verifyRestrictedEgress } from '../../src/sandbox/network.ts'
import { sandboxContainerName, type SandboxSpec } from '../../src/sandbox/types.ts'
import { resolveContainerUser } from '../../src/sandbox/user-mapping.ts'
import { run } from '../../src/util/exec.ts'

/**
 * Opt-in, adversarial E2E for `network_policy: restricted` (ADR-0004).
 * Run with:  PLUTON_E2E_DOCKER=1 npx vitest run --config vitest.e2e.config.ts
 *
 * Requires a reachable Docker engine and a worker image with node (the default
 * `pluton-worker:local`, override with PLUTON_E2E_IMAGE). The suite proves, from
 * inside a real container:
 * - Docker reports the network as internal and the container is attached to it;
 * - a TCP connection to a public address is denied (kernel/routing level, not an
 *   application check);
 * - the same denial holds when the attempt is wrapped in a child shell or when
 *   the destination is resolved through DNS first;
 * - Pluton's own runtime probe agrees with the manual attempts;
 * - containers and the network are cleaned up.
 *
 * Deliberately NOT asserted here: whether the host tool bridge is reachable
 * through the internal network's gateway. That is platform-dependent (Docker
 * Desktop forwards host services differently from a Linux bridge); see
 * docs/SECURITY.md. Egress denial is the security property this suite verifies.
 */

const enabled = process.env['PLUTON_E2E_DOCKER'] === '1'
const describeE2e = enabled ? describe : describe.skip

const IMAGE = process.env['PLUTON_E2E_IMAGE'] ?? 'pluton-worker:local'
const PROJECT = 'pluton-restricted-e2e'
const SHIP = 'e2e-ship'
const CONTAINER = sandboxContainerName(PROJECT, SHIP)
const NETWORK = 'pluton-restricted-e2e'
const EXEC_TIMEOUT_MS = 30_000

const OPEN = 'PLUTON_EGRESS_OPEN'
const BLOCKED = 'PLUTON_EGRESS_BLOCKED'

/** A connect attempt that prints OPEN on success and BLOCKED on any failure. */
const CONNECT_SCRIPT = [
  "const net=require('node:net');",
  'let done=false;',
  "const s=net.connect({host:process.argv[1],port:Number(process.argv[2])});",
  `function finish(m){if(done)return;done=true;console.log(m);s.destroy()}`,
  's.setTimeout(2000);',
  `s.on('connect',()=>finish('${OPEN}'));`,
  `s.on('timeout',()=>finish('${BLOCKED}'));`,
  `s.on('error',()=>finish('${BLOCKED}'));`,
  `setTimeout(()=>finish('${BLOCKED}'),4000).unref()`,
].join('')

/** Resolve a public name first, then connect to whatever the resolver returned. */
const RESOLVE_THEN_CONNECT_SCRIPT = [
  "const net=require('node:net');const dns=require('node:dns');",
  `dns.lookup('example.com',(err,addr)=>{`,
  `if(err){console.log('${BLOCKED}');return}`,
  'let done=false;',
  'const s=net.connect({host:addr,port:443});',
  `function finish(m){if(done)return;done=true;console.log(m);s.destroy()}`,
  's.setTimeout(2500);',
  `s.on('connect',()=>finish('${OPEN}'));`,
  `s.on('timeout',()=>finish('${BLOCKED}'));`,
  `s.on('error',()=>finish('${BLOCKED}'));`,
  `setTimeout(()=>finish('${BLOCKED}'),5000).unref()});`,
].join('')

describeE2e('restricted network E2E (opt-in, real Docker)', () => {
  const sandbox = new DockerSandboxManager()

  beforeAll(async () => {
    const probe = await sandbox.probe()
    expect(probe.available, probe.detail).toBe(true)

    const image = await run(['docker', 'image', 'inspect', '--format', '{{.Id}}', IMAGE], { timeoutMs: 20_000 })
    if (image.exitCode !== 0) {
      throw new Error(
        `E2E image '${IMAGE}' is not available locally; build it with \`pluton sandbox build-image\` or set ` +
          `PLUTON_E2E_IMAGE. docker said: ${image.stderr.trim().slice(0, 300)}`,
      )
    }

    await sandbox.ensureInternalNetwork(NETWORK)
  })

  afterAll(async () => {
    // Cleanup runs even when a test failed: never leave a container or network behind.
    try {
      await sandbox.remove(CONTAINER)
    } catch {
      // container may never have been created
    }
    await run(['docker', 'network', 'rm', NETWORK], { timeoutMs: 20_000 })
  })

  it('creates the container on exactly the internal network', async () => {
    const spec: SandboxSpec = {
      projectId: PROJECT,
      shipId: SHIP,
      image: IMAGE,
      containerName: CONTAINER,
      containerUser: resolveContainerUser().containerUser,
      limits: { cpus: 1, memoryMb: 256, pids: 128 },
      mounts: [],
      env: {},
      network: 'restricted',
      customNetwork: NETWORK,
      extraHosts: ['host.docker.internal:host-gateway'],
    }
    await sandbox.create(spec)
    await sandbox.start(CONTAINER)

    const internal = await run(['docker', 'network', 'inspect', '--format', '{{.Internal}}', NETWORK], {
      timeoutMs: 20_000,
    })
    expect(internal.exitCode, internal.stderr).toBe(0)
    expect(internal.stdout.trim()).toBe('true')

    const info = await sandbox.inspect(CONTAINER)
    expect(info?.networks).toEqual([NETWORK])
  })

  it('denies a direct TCP connection to a public address', async () => {
    const attempt = await sandbox.exec(CONTAINER, ['node', '-e', CONNECT_SCRIPT, '1.1.1.1', '443'], {
      timeoutMs: EXEC_TIMEOUT_MS,
    })
    expect(attempt.timedOut, attempt.stderr).toBe(false)
    expect(attempt.stdout).toContain(BLOCKED)
    expect(attempt.stdout).not.toContain(OPEN)
  })

  it('denies the same attempt from a child shell (no tool-level bypass)', async () => {
    const attempt = await sandbox.exec(
      CONTAINER,
      ['sh', '-lc', `node -e '${CONNECT_SCRIPT.replace(/'/g, `'\\''`)}' 1.1.1.1 443`],
      { timeoutMs: EXEC_TIMEOUT_MS },
    )
    expect(attempt.timedOut, attempt.stderr).toBe(false)
    expect(attempt.stdout).toContain(BLOCKED)
    expect(attempt.stdout).not.toContain(OPEN)
  })

  it('denies egress after DNS resolution (DNS is not a bypass)', async () => {
    const attempt = await sandbox.exec(CONTAINER, ['node', '-e', RESOLVE_THEN_CONNECT_SCRIPT], {
      timeoutMs: EXEC_TIMEOUT_MS,
    })
    expect(attempt.timedOut, attempt.stderr).toBe(false)
    expect(attempt.stdout).toContain(BLOCKED)
    expect(attempt.stdout).not.toContain(OPEN)
  })

  it('Pluton runtime probe proves the denial before a run would start', async () => {
    await expect(verifyRestrictedEgress(sandbox, CONTAINER)).resolves.toBeUndefined()
  })
})
