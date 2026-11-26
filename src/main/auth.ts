// WhatsApp login + encryption keys on disk: same files as Baileys' useMultiFileAuthState, but every write goes
// to a temp file first and is renamed into place. Baileys writes the file in place, so a PC switched off (or
// a crash) mid-write left a truncated session file → that contact's messages stopped decrypting
// ("Aguardando mensagem…") or the login was lost.
import fs from 'node:fs/promises'
import path from 'node:path'
import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type SignalDataTypeMap, type SignalKeyStore } from 'baileys'

const fixFileName = (file: string) => file.replace(/\//g, '__').replace(/:/g, '-')

/** one operation at a time per file (reads wait for the write in progress) */
const locks = new Map<string, Promise<unknown>>()
function locked<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(file) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  locks.set(file, tail)
  void tail.then(() => {
    if (locks.get(file) === tail) locks.delete(file)
  })
  return run
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function writeAtomic(file: string, text: string) {
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, text)
  // Windows: an antivirus or the indexer holding the file makes rename fail for a moment
  for (let i = 0; ; i++) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (err) {
      if (i >= 4) {
        // last resort: the old in-place write (better than losing the update)
        await fs.writeFile(file, text)
        await fs.rm(tmp, { force: true }).catch(() => {})
        return
      }
      await sleep(30 * (i + 1))
    }
  }
}

async function readJsonFile(file: string): Promise<any> {
  for (const f of [file, file + '.tmp']) {
    try {
      const text = await fs.readFile(f, 'utf8')
      if (!text.trim()) continue
      return JSON.parse(text, BufferJSON.reviver)
    } catch {}
  }
  return null
}

export async function useAtomicAuthState(folder: string): Promise<{ state: { creds: AuthenticationCreds; keys: SignalKeyStore }; saveCreds: () => Promise<void> }> {
  await fs.mkdir(folder, { recursive: true })
  const at = (name: string) => path.join(folder, fixFileName(name))
  const write = (data: unknown, name: string) => {
    const file = at(name)
    return locked(file, () => writeAtomic(file, JSON.stringify(data, BufferJSON.replacer)))
  }
  const read = (name: string) => {
    const file = at(name)
    return locked(file, () => readJsonFile(file))
  }
  const remove = (name: string) => {
    const file = at(name)
    return locked(file, () => fs.rm(file, { force: true }).catch(() => {}))
  }

  const creds: AuthenticationCreds = (await read('creds.json')) || initAuthCreds()
  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {}
          await Promise.all(
            ids.map(async (id) => {
              let value = await read(`${type}-${id}.json`)
              if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
              data[id] = value
            })
          )
          return data
        },
        set: async (data: any) => {
          const tasks: Promise<unknown>[] = []
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id]
              const name = `${category}-${id}.json`
              tasks.push(value ? write(value, name) : remove(name))
            }
          }
          await Promise.all(tasks)
        }
      }
    },
    saveCreds: () => write(creds, 'creds.json')
  }
}
