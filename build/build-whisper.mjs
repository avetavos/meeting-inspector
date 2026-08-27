// Builds a self-contained whisper-server into resources/whisper/.
// Run with `npm run build:whisper`; `npm run dist` does it for you.
//
// Homebrew's whisper-server cannot be bundled: its ggml loads backends by dlopen
// from a path fixed at compile time (/opt/homebrew/Cellar/ggml/<v>/libexec), it does
// not look beside the executable, and GGML_BACKEND_PATH names a single file — so
// blas + metal + cpu can never all be found somewhere else. Verified by running it
// with /opt/homebrew unreadable: the server does not start at all.
//
// A static build has no backends to find. The result links nothing outside the
// system frameworks, so it runs on a machine that has never seen Homebrew.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// v1.9.2 aborts when VAD finds no speech in a chunk and an initial prompt was sent —
// which is every silent stretch of the loopback track, since we always send the
// vocabulary prompt. Fixed upstream in v1.9.3.
const VERSION = 'v1.9.3'
const REPO = 'https://github.com/ggml-org/whisper.cpp'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '.whisper-src')
const OUT = join(HERE, '..', 'resources', 'whisper')
const BINARY = join(OUT, 'whisper-server')
const STAMP = join(OUT, '.version')

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })

if (existsSync(BINARY) && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === VERSION) {
  console.log(`whisper-server ${VERSION} already built`)
  process.exit(0)
}

if (!existsSync(join(SRC, 'CMakeLists.txt'))) {
  rmSync(SRC, { recursive: true, force: true })
  run('git', ['clone', '--depth', '1', '--branch', VERSION, REPO, SRC])
}

run(
  'cmake',
  [
    '-B', 'build',
    '-DCMAKE_BUILD_TYPE=Release',
    // The whole point: no shared libs and no dlopened backends to go looking for.
    '-DBUILD_SHARED_LIBS=OFF',
    '-DGGML_BACKEND_DL=OFF',
    // Otherwise the binary needs Homebrew's libomp, which is the problem again.
    '-DGGML_OPENMP=OFF',
    '-DGGML_METAL=ON',
    // Ships the Metal shaders inside the binary rather than as a loose .metallib.
    '-DGGML_METAL_EMBED_LIBRARY=ON',
    '-DWHISPER_BUILD_TESTS=OFF',
    // macOS 13 is the floor anyway — loopback audio needs ScreenCaptureKit.
    '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0',
  ],
  SRC,
)
run('cmake', ['--build', 'build', '--config', 'Release', '-j', String(cpus().length), '--target', 'whisper-server'], SRC)

mkdirSync(OUT, { recursive: true })
copyFileSync(join(SRC, 'build', 'bin', 'whisper-server'), BINARY)
execFileSync('codesign', ['--force', '--sign', '-', BINARY], { stdio: 'ignore' })

// Anything outside the system frameworks would have to be shipped too, and would
// mean the static flags silently did not take.
const external = execFileSync('otool', ['-L', BINARY], { encoding: 'utf8' })
  .split('\n')
  .slice(1)
  .map((line) => line.trim().split(' ')[0])
  .filter((path) => path && !path.startsWith('/usr/lib/') && !path.startsWith('/System/'))
if (external.length > 0) throw new Error(`ไม่ได้ static จริง ยังลิงก์: ${external.join(', ')}`)

writeFileSync(STAMP, `${VERSION}\n`)
console.log(`built whisper-server ${VERSION} into resources/whisper`)
