import type { GlobalConfig } from 'payload'

export const StreamData: GlobalConfig = {
  slug: 'stream-data',
  access: {
    read: () => true,
  },
  fields: [
    {
      name: 'backgrounds',
      label: 'Backgrounds',
      type: 'array',
      labels: {
        singular: 'Background',
        plural: 'Backgrounds',
      },
      fields: [
        {
          name: 'image',
          label: 'Image / GIF / Video',
          type: 'upload',
          relationTo: 'media',
          required: true,
        },
        {
          name: 'duration',
          label: 'Duration (seconds)',
          type: 'number',
          required: true,
          min: 1,
          defaultValue: 300,
        },
      ],
    },
    {
      name: 'mp3Files',
      label: 'MP3 Files',
      type: 'array',
      labels: {
        singular: 'MP3 File',
        plural: 'MP3 Files',
      },
      fields: [
        {
          name: 'file',
          label: 'File',
          type: 'upload',
          relationTo: 'media',
          required: true,
          filterOptions: {
            mimeType: {
              contains: 'audio',
            },
          },
        },
      ],
    },
    {
      name: 'twitchKey',
      label: 'Twitch Key',
      type: 'text',
      required: true,
    },
  ],
}
