// server.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const AdaptiveTemplateProcessor = require('./AdaptiveTemplateProcessor');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Set up multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 52428800 }, // 50MB max size
  fileFilter: function (req, file, cb) {
    if (path.extname(file.originalname).toLowerCase() !== '.zip') {
      return cb(new Error('Only ZIP files are allowed'));
    }
    cb(null, true);
  }
});

// MongoDB Connection
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const dbName = process.env.DB_NAME || 'template_vector_db';

// Set up template processor
const processor = new AdaptiveTemplateProcessor({
  templatesDir: path.join(__dirname, 'uploads'),
  outputDir: path.join(__dirname, 'extracted_templates'),
  assetsDir: path.join(__dirname, 'public', 'assets'),
  mongoUri: mongoUri,
  dbName: dbName,
  apiKey: process.env.OPENAI_API_KEY
});

// Socket.io connection
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// POST /api/upload - Upload a template ZIP file
app.post('/api/upload', upload.single('templateZip'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    
    const uploadedFile = req.file;
    const socketId = req.body.socketId;
    const socket = socketId ? io.to(socketId) : null;
    
    // Respond immediately to client
    res.json({
      success: true,
      message: 'File uploaded successfully',
      file: {
        name: uploadedFile.originalname,
        size: uploadedFile.size,
        path: uploadedFile.path
      }
    });
    
    // Process template in background
    const filePath = uploadedFile.path;
    
    // Set up event handlers for progress updates
    processor.on('progress', (data) => {
      if (socket) {
        socket.emit('processing-progress', {
          fileName: uploadedFile.originalname,
          ...data
        });
      }
      console.log(`[${uploadedFile.originalname}] Progress:`, data);
    });
    
    processor.on('complete', (data) => {
      if (socket) {
        socket.emit('processing-complete', {
          fileName: uploadedFile.originalname,
          ...data
        });
      }
      console.log(`[${uploadedFile.originalname}] Processing complete:`, data);
    });
    
    processor.on('error', (data) => {
      if (socket) {
        socket.emit('processing-error', {
          fileName: uploadedFile.originalname,
          ...data
        });
      }
      console.error(`[${uploadedFile.originalname}] Processing error:`, data);
    });
    
    // Start processing the template
    await processor.processTemplateZip(filePath);
    
  } catch (error) {
    console.error('Error processing template upload:', error);
    // We've already sent a response, so use socket.io to notify of error
    if (req.body.socketId) {
      io.to(req.body.socketId).emit('processing-error', {
        fileName: req.file ? req.file.originalname : 'unknown',
        error: error.message
      });
    }
  }
});

// GET /api/templates - Get all processed templates
app.get('/api/templates', async (req, res) => {
  let client = null;
  
  try {
    client = new MongoClient(mongoUri);
    await client.connect();
    
    const db = client.db(dbName);
    const collection = db.collection('templates');
    
    const templates = await collection.find().sort({ createdAt: -1 }).toArray();
    
    res.json({
      success: true,
      templates
    });
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching templates',
      error: error.message
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
});

// GET /api/templates/:id - Get a specific template with its components
app.get('/api/templates/:id', async (req, res) => {
  let client = null;
  
  try {
    client = new MongoClient(mongoUri);
    await client.connect();
    
    const db = client.db(dbName);
    const templatesCollection = db.collection('templates');
    const componentsCollection = db.collection('components');
    
    const template = await templatesCollection.findOne({ _id: req.params.id });
    
    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }
    
    const components = await componentsCollection.find({ templateId: req.params.id })
      .project({ embedding: 0 }) // Exclude the large embedding field
      .toArray();
    
    res.json({
      success: true,
      template,
      components
    });
  } catch (error) {
    console.error('Error fetching template details:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching template details',
      error: error.message
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
});

// DELETE /api/templates/:id - Delete a template and its components
app.delete('/api/templates/:id', async (req, res) => {
  let client = null;
  
  try {
    client = new MongoClient(mongoUri);
    await client.connect();
    
    const db = client.db(dbName);
    const templatesCollection = db.collection('templates');
    const componentsCollection = db.collection('components');
    
    // Delete the template
    const templateResult = await templatesCollection.deleteOne({ _id: req.params.id });
    
    if (templateResult.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }
    
    // Delete all components from this template
    const componentsResult = await componentsCollection.deleteMany({ templateId: req.params.id });
    
    // Optionally, delete assets (uncomment if needed)
    // const assetsDir = path.join(__dirname, 'public', 'assets', req.params.id);
    // if (fs.existsSync(assetsDir)) {
    //   fs.rmSync(assetsDir, { recursive: true, force: true });
    // }
    
    res.json({
      success: true,
      message: 'Template deleted successfully',
      deletedComponents: componentsResult.deletedCount
    });
  } catch (error) {
    console.error('Error deleting template:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting template',
      error: error.message
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
});

// GET /api/stats - Get database statistics
app.get('/api/stats', async (req, res) => {
  let client = null;
  
  try {
    client = new MongoClient(mongoUri);
    await client.connect();
    
    const db = client.db(dbName);
    const templatesCollection = db.collection('templates');
    const componentsCollection = db.collection('components');
    
    // Total counts
    const totalTemplates = await templatesCollection.countDocuments();
    const totalComponents = await componentsCollection.countDocuments();
    
    // Components by type
    const componentsByType = await componentsCollection.aggregate([
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();
    
    // Templates by industry
    const templatesByIndustry = await templatesCollection.aggregate([
      { $group: { _id: '$industry', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();
    
    // Format the results
    const categoriesCoverage = {};
    componentsByType.forEach(item => {
      categoriesCoverage[item._id] = item.count;
    });
    
    const industriesCoverage = {};
    templatesByIndustry.forEach(item => {
      industriesCoverage[item._id] = item.count;
    });
    
    res.json({
      success: true,
      stats: {
        totalTemplates,
        totalComponents,
        categoriesCoverage,
        industriesCoverage
      }
    });
  } catch (error) {
    console.error('Error fetching database stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching database stats',
      error: error.message
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
});

// GET /api/search - Search components by text and filters
app.get('/api/search', async (req, res) => {
  let client = null;
  
  try {
    client = new MongoClient(mongoUri);
    await client.connect();
    
    const db = client.db(dbName);
    const componentsCollection = db.collection('components');
    
    const { query, type, industry, limit = 20 } = req.query;
    
    // Build the search filter
    const filter = {};
    
    if (type) {
      filter.type = type;
    }
    
    if (industry) {
      filter.industry = industry;
    }
    
    // If there's a text query, we'll use vector search
    if (query) {
      // Create embedding for the query
      const embedding = await processor.embeddings.embedQuery(query);
      
      // Perform vector search
      const results = await componentsCollection.aggregate([
        {
          $search: {
            index: 'components_vector_index',
            knnBeta: {
              vector: embedding,
              path: 'embedding',
              k: parseInt(limit)
            },
            filter
          }
        },
        {
          $project: {
            _id: 1,
            type: 1,
            name: 1,
            industry: 1,
            styleType: 1,
            templateId: 1,
            attributes: 1,
            score: { $meta: 'searchScore' }
          }
        }
      ]).toArray();
      
      res.json({
        success: true,
        results
      });
    } else {
      // If no query, just filter by type and industry
      const results = await componentsCollection.find(filter)
        .project({
          _id: 1,
          type: 1,
          name: 1,
          industry: 1,
          styleType: 1,
          templateId: 1,
          attributes: 1
        })
        .limit(parseInt(limit))
        .toArray();
      
      res.json({
        success: true,
        results
      });
    }
  } catch (error) {
    console.error('Error searching components:', error);
    res.status(500).json({
      success: false,
      message: 'Error searching components',
      error: error.message
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});