const { getAuth } = require('./lib/auth')
const { fetchGoogleDriveFiles } = require('./lib/google-drive')
const { fetchGoogleDocsDocuments } = require('./lib/google-docs')
const { mapValues, trim, trimEnd } = require('lodash')

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
    }
  }

  constructor (api, options) {
    this.refsCache = {}
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
    documents.forEach(document => {
      console.log(document)
      const options = this.createNodeOptions(document, actions)
      const node = this.collection.addNode(options)
      this.createNodeRefs(node, actions)
    })
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

  createNodeOptions (document, actions) {
    const origin = 'GoogleDocs'
    const content = document.markdown
    const mimeType = 'text/markdown'

    return {
      ...document,
      // body: document.markdown,
      content: JSON.stringify(document.content),
      // slug: actions.slugify(document.title),
      // path: this.createPath({ dir, name }, actions),
      internal: {
        mimeType,
        content,
        origin
      }
    }
  }

  addRefNode (typeName, fieldName, value, actions) {
    const getCollection = actions.getCollection || actions.getContentType
    const cacheKey = `${typeName}-${fieldName}-${value}`

    if (!this.refsCache[cacheKey] && value) {
      this.refsCache[cacheKey] = true

      getCollection(typeName).addNode({ id: value, title: value })
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
}
  
module.exports = GoogleDocsSource
