const { getAuth } = require('./lib/auth')
const { fetchGoogleDriveFiles } = require('./lib/google-drive')
const { fetchGoogleDocsDocuments } = require('./lib/google-docs')
const convertJsonToMarkdown = require('./lib/convert-json-to-markdown')
const file = require('./lib/file.js')
const { mapValues, trim, trimEnd } = require('lodash')

const ISDEV = process.env.NODE_ENV === 'development'

class GoogleDocsSource {
  static defaultOptions () {
    return {
      typeName: 'GoogleDocs',
      refs: {},
      // Google specific stuff
      accessType: 'offline',
      redirectUris: ['urn:ietf:wg:oauth:2.0:oob', 'http://localhost'],
      scope: [
        'https://www.googleapis.com/auth/documents.readonly',
        'https://www.googleapis.com/auth/drive.metadata.readonly'
      ],
      tokenPath: 'google-docs-token.json',
      numNodes: 10,
      fields: ['createdTime'],
      fieldsMapper: { createdTime: 'date', name: 'title' },
      fieldsDefault: { draft: false },
      imageDirectory: 'gdocs_images',
      downloadImages: true
    }
  }

  constructor (api, options) {
    this.refsCache = {}
    
    if (options.downloadImages) {
      this.imageDirectory = options.imageDirectory
      file.createDirectory(this.imageDirectory)
    }

    this.options = options
    api.loadSource(async (actions) => {
      this.createCollections(actions)
      await this.createNodes(options, actions)
    })
  }

  async fetchDocuments (options) {
    if (!options.apiKey) {
      throw new Error('source-google-docs: Missing API key')
    }

    if (!options.clientId) {
      throw new Error('source-google-docs: Missing client id')
    }

    if (!options.clientSecret) {
      throw new Error('source-google-docs: Missing client secret')
    }

    if (!options.foldersIds) {
      throw new Error('source-google-docs: Missing folders ids')
    }

    const auth = await getAuth({
      ...options
    })

    const googleDriveFiles = await fetchGoogleDriveFiles({
      auth,
      rootFolderIds: options.foldersIds,
      fields: options.fields,
      fieldsMapper: options.fieldsMapper,
      fieldsDefault: options.fieldsDefault
    })

    return await fetchGoogleDocsDocuments({
      auth,
      apiKey: options.apiKey,
      googleDriveFiles
    })
  }

  createCollections (actions) {
    const addCollection = actions.addCollection || actions.addContentType

    this.refs = this.normalizeRefs(this.options.refs)

    this.collection = addCollection({
      typeName: this.options.typeName,
      route: this.options.route
    })

    mapValues(this.refs, (ref, key) => {
      this.collection.addReference(key, ref.typeName)

      if (ref.create) {
        addCollection({
          typeName: ref.typeName,
          route: ref.route
        })
      }
    })
  }

  async createNodes (options, actions) {
    const documents = await this.fetchDocuments(options)

    for (let index = 0; index < documents.length; index++) {
      let document = documents[index]
      // console.log('document', JSON.parse(JSON.stringify(document)))
      let node = await this.normalizeField(document, actions)
      // console.log('normalized node', JSON.parse(JSON.stringify(node)))
      const content = node.content
      delete node.content
      const markdown = await convertJsonToMarkdown({ file: node, content: content })

      const origin = 'GoogleDocs'
      const mimeType = 'text/markdown'
      
      node = {...node,
        markdown,
        internal: {
          mimeType,
          content: markdown,
          origin
        }
      }

      node = this.collection.addNode(node)
      this.createNodeRefs(node, actions)
    }
  }

  createNodeRefs (node, actions) {
    for (const fieldName in this.refs) {
      const ref = this.refs[fieldName]

      if (node && node[fieldName] && ref.create) {
        const value = node[fieldName]
        const typeName = ref.typeName

        if (Array.isArray(value)) {
          value.forEach(value =>
            this.addRefNode(typeName, fieldName, value, actions)
          )
        } else {
          this.addRefNode(typeName, fieldName, value, actions)
        }
      }
    }
  }

  // helpers
  addRefNode (typeName, fieldName, value, actions) {
    const getCollection = actions.getCollection || actions.getContentType
    const cacheKey = `${typeName}-${fieldName}-${value}`

    if (!this.refsCache[cacheKey] && value) {
      this.refsCache[cacheKey] = true

      getCollection(typeName).addNode({ id: value, title: value }, actions)
    }
  }
  
  normalizeRefs (refs) {
    return mapValues(refs, (ref) => {
      if (typeof ref === 'string') {
        ref = { typeName: ref, create: false }
      }
      
      if (!ref.typeName) {
        ref.typeName = this.options.typeName
      }
      
      if (ref.create) {
        ref.create = true
      } else {
        ref.create = false
      }
      
      return ref
    })
  }

  async normalizeField(field, actions) {
    if (!field) return field
    switch (typeof field) {
      case "string":
        if (field.match(/^https:\/\/.*\/.*\.(jpg|png|svg|gif|jpeg)($|\?)/i)) {
          return await this.downloadImage(field, false, actions)
        } else return field
      case "number": return field
      case "boolean": return field
      case "object":
        if (Array.isArray(field)) {
          const tmp = []
          for (let index = 0; index < field.length; index++) {
            tmp.push(await this.normalizeField(field[index], actions))
          }
          return tmp
        }

        const tmp = {}
        const keys = Object.keys(field)
        
        for (let index = 0; index < keys.length; index++) {
          const p = keys[index]
          if (field.hasOwnProperty(p))
            if (p === 'img' && field[p].hasOwnProperty('source')) {
              tmp[p] = field[p]
              tmp[p].source = await this.downloadImage(field[p].source, true, actions)
            } else {
              tmp[p] = await this.normalizeField(field[p], actions)
            }
        }
        return tmp
    }
  }

  async downloadImage(url, isGoogleDocsImage, actions) {
    const filename = file.getFilename(url)
    const id = actions.makeUid(url)
    const filepath = file.getFullPath(this.imageDirectory, filename)

    if (!file.exists(filepath)) {
      if (isGoogleDocsImage) {
        return await file.downloadGoogleDocsImage(url, filepath)
      } else {
        file.download(url, filepath)
        return filepath
      }
      
    } else {
      ISDEV && console.log(`${filename} already exists`)
      return filepath
    }
  }
}
  
module.exports = GoogleDocsSource
