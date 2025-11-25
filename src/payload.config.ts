// storage-adapter-import-placeholder
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { sql } from 'drizzle-orm'

import { Users } from './collections/Users'
import { Media } from './collections/Media'
import { StreamData } from './globals/StreamData'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
    components: {
      providers: ['./components/admin/StartStreamProvider'],
    },
  },
  collections: [Users, Media],
  globals: [StreamData],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || '',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URI || '',
    },
  }),
  onInit: async (payload) => {
    // Ensure duration column exists for backgrounds; idempotent.
    try {
      await payload.db.drizzle.execute(
        sql`alter table "stream_data_backgrounds" add column if not exists "duration" numeric`,
      )
    } catch (err) {
      payload.logger.warn({ err }, 'failed to ensure duration column')
    }
  },
  sharp,
  plugins: [
    // storage-adapter-placeholder
  ],
})
