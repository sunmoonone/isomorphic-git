// This is a convenience wrapper for reading and writing files in the 'refs' directory.
import path from 'path'
import { GitConfigManager } from './GitConfigManager'
import { FileSystem, GitRefSpecSet } from '../models'

// @see https://git-scm.com/docs/git-rev-parse.html#_specifying_revisions
const refpaths = ref => [
  `${ref}`,
  `refs/${ref}`,
  `refs/tags/${ref}`,
  `refs/heads/${ref}`,
  `refs/remotes/${ref}`,
  `refs/remotes/${ref}/HEAD`
]

/** @ignore */
export class GitRefManager {
  /* ::
  updateRemoteRefs : ({
    gitdir: string,
    remote: string,
    refs: Map<string, string>,
    symrefs: Map<string, string>
  }) => Promise<void>
  */
  static async updateRemoteRefs ({
    fs: _fs,
    gitdir,
    remote,
    refs,
    symrefs,
    tags,
    refspecs
  }) {
    const fs = new FileSystem(_fs)
    // Validate input
    for (let value of refs.values()) {
      if (!value.match(/[0-9a-f]{40}/)) {
        throw new Error(`Unexpected ref contents: '${value}'`)
      }
    }
    const config = await GitConfigManager.get({ fs, gitdir })
    if (!refspecs) {
      refspecs = await config.getall(`remote.${remote}.fetch`)
    }
    const refspec = GitRefSpecSet.from(refspecs)
    // Combine refs and symrefs giving symrefs priority
    let actualRefsToWrite = new Map()
    let refTranslations = refspec.translate([...refs.keys()])
    for (let [serverRef, translatedRef] of refTranslations) {
      let value = refs.get(serverRef)
      actualRefsToWrite.set(translatedRef, value)
    }
    let symrefTranslations = refspec.translate([...symrefs.keys()])
    for (let [serverRef, translatedRef] of symrefTranslations) {
      let value = symrefs.get(serverRef)
      let symtarget = refspec.translateOne(value)
      if (symtarget) {
        actualRefsToWrite.set(translatedRef, `ref: ${symtarget}`)
      }
    }
    // Update files
    // TODO: For large repos with a history of thousands of pull requests
    // (i.e. gitlab-ce) it would be vastly more efficient to write them
    // to .git/packed-refs.
    // The trick is to make sure we a) don't write a packed ref that is
    // already shadowed by a loose ref and b) don't loose any refs already
    // in packed-refs. Doing this efficiently may be difficult. A
    // solution that might work is
    // a) load the current packed-refs file
    // b) add actualRefsToWrite, overriding the existing values if present
    // c) enumerate all the loose refs currently in .git/refs/remotes/${remote}
    // d) overwrite their value with the new value.
    // Examples of refs we need to avoid writing in loose format for efficieny's sake
    // are .git/refs/remotes/origin/refs/remotes/remote_mirror_3059
    // and .git/refs/remotes/origin/refs/merge-requests
    const normalizeValue = value => value.trim() + '\n'
    for (let [key, value] of actualRefsToWrite) {
      if (
        tags === true &&
        key.startsWith('refs/tags') &&
        !key.endsWith('^{}')
      ) {
        const filename = path.join(gitdir, key)
        // Git's behavior is to only fetch tags that do not conflict with tags already present.
        if (!await fs.exists(filename)) {
          await fs.write(filename, normalizeValue(value), 'utf8')
        }
      } else if (key.startsWith('refs/') || key === 'HEAD') {
        await fs.write(path.join(gitdir, key), normalizeValue(value), 'utf8')
      }
    }
  }
  // TODO: make this less crude?
  static async writeRef ({ fs: _fs, gitdir, ref, value }) {
    const fs = new FileSystem(_fs)
    // Validate input
    if (!value.match(/[0-9a-f]{40}/)) {
      throw new Error(`Unexpected ref contents: '${value}'`)
    }
    const normalizeValue = value => value.trim() + '\n'
    await fs.write(path.join(gitdir, ref), normalizeValue(value), 'utf8')
  }
  static async resolve ({ fs: _fs, gitdir, ref, depth }) {
    const fs = new FileSystem(_fs)
    if (depth !== undefined) {
      depth--
      if (depth === -1) {
        return ref
      }
    }
    let sha
    // Is it a ref pointer?
    if (ref.startsWith('ref: ')) {
      ref = ref.slice('ref: '.length)
      return GitRefManager.resolve({ fs, gitdir, ref, depth })
    }
    // Is it a complete and valid SHA?
    if (ref.length === 40 && /[0-9a-f]{40}/.test(ref)) {
      return ref
    }
    // We need to alternate between the file system and the packed-refs
    let packedMap = await GitRefManager.packedRefs({ fs, gitdir })
    // Look in all the proper paths, in this order
    const allpaths = refpaths(ref)
    for (let ref of allpaths) {
      sha =
        (await fs.read(`${gitdir}/${ref}`, { encoding: 'utf8' })) ||
        packedMap.get(ref)
      if (sha) {
        return GitRefManager.resolve({ fs, gitdir, ref: sha.trim(), depth })
      }
    }
    // Do we give up?
    throw new Error(`Could not resolve reference ${ref}`)
  }
  static resolveAgainstMap ({ ref, depth, map }) {
    if (depth !== undefined) {
      depth--
      if (depth === -1) {
        return ref
      }
    }
    // Is it a ref pointer?
    if (ref.startsWith('ref: ')) {
      ref = ref.slice('ref: '.length)
      return GitRefManager.resolveAgainstMap({ ref, depth, map })
    }
    // Is it a complete and valid SHA?
    if (ref.length === 40 && /[0-9a-f]{40}/.test(ref)) {
      return ref
    }
    // Look in all the proper paths, in this order
    const allpaths = refpaths(ref)
    for (let ref of allpaths) {
      let sha = map.get(ref)
      if (sha) {
        return GitRefManager.resolveAgainstMap({ ref: sha.trim(), depth, map })
      }
    }
    // Do we give up?
    throw new Error(`Could not resolve reference ${ref}`)
  }
  static async packedRefs ({ fs: _fs, gitdir }) {
    const refs = new Map()
    const fs = new FileSystem(_fs)
    const text = await fs.read(`${gitdir}/packed-refs`, { encoding: 'utf8' })
    if (!text) return refs
    const lines = text
      .trim()
      .split('\n')
      .filter(line => !/^\s*#/.test(line))
    let key = null
    for (let line of lines) {
      const i = line.indexOf(' ')
      if (line.startsWith('^')) {
        // This is a oid for the commit associated with the annotated tag immediately preceding this line.
        // Trim off the '^'
        const value = line.slice(1, i)
        // The tagname^{} syntax is based on the output of `git show-ref --tags -d`
        refs.set(key + '^{}', value)
      } else {
        // This is an oid followed by the ref name
        const value = line.slice(0, i)
        key = line.slice(i + 1)
        refs.set(key, value)
      }
    }
    return refs
  }
  // List all the refs that match the `filepath` prefix
  static async listRefs ({ fs: _fs, gitdir, filepath }) {
    const fs = new FileSystem(_fs)
    let packedMap = GitRefManager.packedRefs({ fs, gitdir })
    let files = null
    try {
      files = await fs.readdirDeep(`${gitdir}/${filepath}`)
      files = files.map(x => x.replace(`${gitdir}/${filepath}/`, ''))
    } catch (err) {
      files = []
    }

    for (let key of (await packedMap).keys()) {
      // filter by prefix
      if (key.startsWith(filepath)) {
        // remove prefix
        key = key.replace(filepath + '/', '')
        // Don't include duplicates; the loose files have precedence anyway
        if (!files.includes(key)) {
          files.push(key)
        }
      }
    }
    return files
  }
  static async listBranches ({ fs: _fs, gitdir, remote }) {
    const fs = new FileSystem(_fs)
    if (remote) {
      return GitRefManager.listRefs({
        fs,
        gitdir,
        filepath: `refs/remotes/${remote}`
      })
    } else {
      return GitRefManager.listRefs({ fs, gitdir, filepath: `refs/heads` })
    }
  }
  static async listTags ({ fs: _fs, gitdir }) {
    const fs = new FileSystem(_fs)
    let tags = await GitRefManager.listRefs({
      fs,
      gitdir,
      filepath: `refs/tags`
    })
    tags = tags.filter(x => !x.endsWith('^{}'))
    return tags
  }
}
