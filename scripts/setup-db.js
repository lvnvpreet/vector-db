// scripts/setup-db.js
/**
 * This script sets up the MongoDB database and creates necessary collections and indexes
 * for the Template Vector Database system.
 * 
 * Usage: node scripts/setup-db.js
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

async function setupDatabase() {
  // Connect to MongoDB
  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017');
  
  try {
    console.log('Connecting to MongoDB...');
    await client.connect();
    console.log('Connected successfully to MongoDB');
    
    const dbName = process.env.DB_NAME || 'template_vector_db';
    const db = client.db(dbName);
    
    console.log(`Setting up database: ${dbName}`);
    
    // Create collections if they don't exist
    console.log('Creating collections if they don\'t exist...');
    
    // Components collection
    await db.createCollection('components');
    console.log('- Created "components" collection');
    
    // Templates collection
    await db.createCollection('templates');
    console.log('- Created "templates" collection');
    
    // Process logs collection
    await db.createCollection('process_logs');
    console.log('- Created "process_logs" collection');
    
    // Create indexes
    console.log('Creating indexes...');
    
    // Components indexes
    const componentsCollection = db.collection('components');
    await componentsCollection.createIndex({ type: 1 });
    await componentsCollection.createIndex({ industry: 1 });
    await componentsCollection.createIndex({ templateId: 1 });
    await componentsCollection.createIndex({ 'attributes.hasImage': 1 });
    await componentsCollection.createIndex({ createdAt: 1 });
    console.log('- Created standard indexes on "components" collection');
    
    // Check if the vector search index already exists (only in MongoDB Atlas)
    console.log('Note: Vector search index needs to be created in MongoDB Atlas');
    console.log('Please create a vector search index named "components_vector_index" on the "components" collection');
    console.log('with the configuration:');
    console.log(`{
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
}`);
    
    // Templates indexes
    const templatesCollection = db.collection('templates');
    await templatesCollection.createIndex({ industry: 1 });
    await templatesCollection.createIndex({ styleType: 1 });
    await templatesCollection.createIndex({ createdAt: 1 });
    console.log('- Created indexes on "templates" collection');
    
    // Process logs indexes
    const processLogsCollection = db.collection('process_logs');
    await processLogsCollection.createIndex({ templateId: 1 });
    await processLogsCollection.createIndex({ status: 1 });
    await processLogsCollection.createIndex({ startTime: 1 });
    console.log('- Created indexes on "process_logs" collection');
    
    console.log('Database setup completed successfully!');
    
  } catch (error) {
    console.error('Error setting up database:', error);
    process.exit(1);
  } finally {
    await client.close();
    console.log('MongoDB connection closed');
  }
}

setupDatabase().catch(console.error);