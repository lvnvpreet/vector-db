# Template Vector Database Generator

A comprehensive system for processing website templates with varying directory structures, extracting components, and creating a vector database for RAG-enhanced website generation.

## Overview

This system allows you to upload website template ZIP files, processes them to extract components (headers, footers, hero sections, etc.), generates vector embeddings, and stores them in a MongoDB database. These components can then be used to enhance AI generation of websites by providing relevant examples.

## Features

- **Adaptive Template Processing**: Handles different template directory structures automatically
- **Component Extraction**: Intelligently identifies and extracts key web components
- **Industry Classification**: Automatically categorizes templates by industry and style
- **Vector Embeddings**: Generates embeddings for semantic search
- **Real-time Processing**: Monitors processing progress via Socket.io
- **Dashboard Interface**: Visualize and manage templates and components

## Prerequisites

- Node.js 16+ 
- MongoDB (local or MongoDB Atlas)
- OpenAI API key (for generating embeddings)

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/template-vector-db-generator.git
   cd template-vector-db-generator
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create a `.env` file based on `.env.example`:
   ```
   cp .env.example .env
   ```

4. Edit the `.env` file with your configuration (MongoDB URI, OpenAI API key, etc.)

5. Set up the MongoDB database:
   ```
   npm run setup-db
   ```

6. Start the server:
   ```
   npm start
   ```

7. Access the application at `http://localhost:3000`

## MongoDB Vector Search Setup

This system uses MongoDB Atlas Vector Search for similarity search. To set up:

1. Create a MongoDB Atlas cluster (M0 free tier works for testing)
2. Create a vector search index on the `components` collection with the following configuration:

```json
{
  "fields": [
    {
      "path": "embedding",
      "type": "vector",
      "dimensions": 1536,
      "similarity": "cosine"
    },
    {
      "path": "type",
      "type": "filter" 
    },
    {
      "path": "industry",
      "type": "filter"
    }
  ]
}
```

## Usage

### Template Upload

1. Zip your template files with a valid structure:
   - All template files should be in a single ZIP archive
   - Structure varies but commonly includes HTML, CSS, JS, and image files
   
2. Upload the ZIP file through the web interface

3. Monitor the processing stages:
   - Extraction
   - Structure analysis
   - Component identification
   - Asset processing
   - Embedding generation
   - Database storage

### Using the Components

The extracted components can be used to enhance website generation via RAG:

1. Search for components by:
   - Component type (header, footer, hero, etc.)
   - Industry (real estate, restaurant, education, etc.)
   - Text similarity (using vector search)

2. Retrieve relevant components to use as examples for your AI-based website generator

3. Incorporate the HTML and CSS into your generation prompts

## System Architecture

The system follows a comprehensive pipeline:

1. **Template Collection**: ZIP files uploaded to the system
2. **Extraction & Analysis**: Files extracted and directory structure analyzed
3. **Structure Detection**: Template framework and structure pattern identified
4. **Component Extraction**: HTML components identified and extracted
5. **Asset Processing**: Images and other assets processed and paths normalized
6. **Metadata Enrichment**: Component properties and features identified
7. **Vector Embedding**: Text representations converted to vectors
8. **Database Storage**: Components stored with metadata and embeddings
9. **Retrieval & Integration**: Components retrieved for website generation

## API Endpoints

- `POST /api/upload` - Upload a template ZIP file
- `GET /api/templates` - Get all processed templates
- `GET /api/templates/:id` - Get a specific template with components
- `DELETE /api/templates/:id` - Delete a template and its components
- `GET /api/stats` - Get database statistics
- `GET /api/search` - Search components by text and filters

## Development

To run the server in development mode with auto-reload:

```
npm run dev
```

## Directory Structure

```
├── public/                # Static files
│   ├── assets/            # Processed template assets
│   └── index.html         # Main UI
├── uploads/               # Temporary storage for uploaded ZIPs
├── extracted_templates/   # Extracted template files
├── scripts/               # Utility scripts
│   └── setup-db.js        # Database setup script
├── AdaptiveTemplateProcessor.js  # Core processing logic
├── server.js              # Express server
├── package.json           # Dependencies and scripts
└── .env                   # Environment configuration
```

## License

MIT