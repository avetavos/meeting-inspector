// Lists the meeting scripts, or prints one to read aloud.
//   npm run asr:read          list them
//   npm run asr:read -- 02    print that one
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const DIR = new URL('scripts/', import.meta.url).pathname
const scripts = (await readdir(DIR)).filter((f) => f.endsWith('.txt')).sort()
const wanted = process.argv[2]

if (!wanted) {
  console.log('บทสำหรับจำลองประชุม — อ่านออกเสียงระหว่างที่แอปอัดอยู่\n')
  for (const file of scripts) {
    const text = await readFile(join(DIR, file), 'utf8')
    const terms = (text.split('\n').find((l) => l.startsWith('TERMS:')) ?? '').split(',').length
    const spoken = text.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('TERMS:'))
    const words = spoken.join(' ').split(/\s+/).length
    const people = new Set(spoken.map((l) => /^([^:]{1,20}):\s/.exec(l)?.[1]).filter(Boolean))
    const cast = /^#\s*CAST:\s*(.+)$/m.exec(text)?.[1]?.trim()
    const who = people.size > 1 ? `${people.size} คน${cast ? ` ${cast}` : ''}` : '1 คน'
    console.log(`  ${file.slice(0, 2)}  ${file.slice(3, -4).padEnd(16)} ${who.padEnd(18)} ~${words} คำ, ${terms} ศัพท์`)
  }
  console.log('\n  npm run asr:read -- 02     อ่านบทนั้น')
  console.log('  npm run asr:score -- 02    ให้คะแนนการประชุมล่าสุดเทียบกับบทนั้น')
  process.exit(0)
}

const file = scripts.find((f) => f.startsWith(wanted)) ?? scripts.find((f) => f.includes(wanted))
if (!file) {
  console.error(`ไม่พบบท "${wanted}" — มี: ${scripts.map((f) => f.slice(0, 2)).join(', ')}`)
  process.exit(1)
}
console.log(await readFile(join(DIR, file), 'utf8'))
