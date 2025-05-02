// server.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const AdaptiveTemplateProcessor = require('./AdaptiveTemplateProcessor');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Debug mode
const debugMode = process.env.DEBUG_MODE === 'true';

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
  ollamaUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text',
  debugMode: debugMode
});


// Socket.io connection
io.on('connection', (socket) => {
  if (debugMode) {
    console.log('New client connected:', socket.id);
  }

  socket.on('disconnect', () => {
    if (debugMode) {
      console.log('Client disconnected:', socket.id);
    }
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
      if (debugMode) {
        console.log(`[${uploadedFile.originalname}] Progress:`, data);
      }
    });

    processor.on('complete', (data) => {
      if (socket) {
        socket.emit('processing-complete', {
          fileName: uploadedFile.originalname,
          ...data
        });
      }
      if (debugMode) {
        console.log(`[${uploadedFile.originalname}] Processing complete:`, data);
      }
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

// GET /api/template-structure/:id - Get the full template structure
app.get('/api/template-structure/:id', async (req, res) => {
  let client = null;

  try {
    client = new MongoClient(mongoUri);
    await client.connect();

    const db = client.db(dbName);
    const collection = db.collection('template_structures');

    const templateStructure = await collection.findOne({ _id: req.params.id });

    if (!templateStructure) {
      return res.status(404).json({
        success: false,
        message: 'Template structure not found'
      });
    }

    res.json({
      success: true,
      templateStructure
    });
  } catch (error) {
    console.error('Error fetching template structure:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching template structure',
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
    const templateStructuresCollection = db.collection('template_structures');
    const templateEmbeddingsCollection = db.collection('template_embeddings');

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

    // Delete template structure
    await templateStructuresCollection.deleteOne({ _id: req.params.id });

    // Delete template embedding
    await templateEmbeddingsCollection.deleteOne({ _id: req.params.id });

    // Optionally, delete assets (uncomment if needed)
    const assetsDir = path.join(__dirname, 'public', 'assets', req.params.id);
    if (fs.existsSync(assetsDir)) {
      fs.rmSync(assetsDir, { recursive: true, force: true });
    }

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
      const embedding = await processor.generateOllamaEmbedding(query);

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
            useCaseInfo: 1,
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
          attributes: 1,
          useCaseInfo: 1
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

// GET /api/search-components - Vector search for components
app.get('/api/search-components', async (req, res) => {
  let client = null;

  try {
    client = new MongoClient(mongoUri);
    await client.connect();

    const db = client.db(dbName);
    const componentsCollection = db.collection('components');

    const { query, type, industry, limit = 5 } = req.query;

    // Build the search filter
    const filter = {};

    if (type) {
      filter.type = type;
    }

    if (industry) {
      filter.industry = industry;
    }

    // If there's a text query, use vector search
    if (query) {
      // Create embedding for the query
      // const embedding = await processor.embeddings.embedQuery(query);

      // Create embedding for the query - check if embeddings exists
      let embedding;
      if (processor && processor.embeddings && typeof processor.embeddings.embedQuery === 'function') {
        embedding = await processor.embeddings.embedQuery(query);
      } else if (processor && typeof processor.generateEmbedding === 'function') {
        // Fallback if the embedQuery method isn't directly available
        embedding = await processor.generateEmbedding(query);
      } else {
        throw new Error("Embedding functionality not available");
      }


      // Build the search query with compound operator for filtering
      const searchQuery = {
        $search: {
          index: 'components_vector_index',
          compound: {
            must: [{
              knnBeta: {
                vector: embedding,
                path: 'embedding',
                k: parseInt(limit)
              }
            }],
            filter: []
          }
        }
      };

      // Add filters to compound.filter array if needed
      if (type) {
        searchQuery.$search.compound.filter.push({
          equals: { path: 'type', value: type }
        });
      }

      if (industry) {
        searchQuery.$search.compound.filter.push({
          equals: { path: 'industry', value: industry }
        });
      }

      // If no filters needed, use simplified query without compound
      if (searchQuery.$search.compound.filter.length === 0) {
        searchQuery.$search = {
          index: 'components_vector_index',
          knnBeta: {
            vector: embedding,
            path: 'embedding',
            k: parseInt(limit)
          }
        };
      }

      // Perform vector search
      const results = await componentsCollection.aggregate([
        searchQuery,
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
        html: 1,
        css: 1,
        industry: 1,
        styleType: 1,
        templateId: 1,
        attributes: 1,
        useCaseInfo: 1
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

// GET /api/search-templates - Search templates by vector similarity
app.get('/api/search-templates', async (req, res) => {
  let client = null;

  try {
    client = new MongoClient(mongoUri);
    await client.connect();

    const db = client.db(dbName);
    const templateEmbeddingsCollection = db.collection('template_embeddings');
    const templatesCollection = db.collection('templates');

    const { query, industry, style, limit = 3 } = req.query;

    // Build the search filter
    const filter = {};

    if (industry) {
      filter.industry = industry;
    }

    if (style) {
      filter.styleType = style;
    }

    // If there's a text query, use vector search
    if (query) {
      // Create embedding for the query
      const embedding = await processor.generateOllamaEmbedding(query);

      // Perform vector search
      const embeddingResults = await templateEmbeddingsCollection.aggregate([
        {
          $search: {
            index: 'template_embeddings_vector_index', // You'll need to create this index
            knnBeta: {
              vector: embedding,
              path: 'embedding',
              k: parseInt(limit)
            }
          }
        },
        {
          $project: {
            _id: 1,
            metaData: 1,
            score: { $meta: 'searchScore' }
          }
        }
      ]).toArray();

      // Get full template data
      const templateIds = embeddingResults.map(result => result._id);
      const templates = await templatesCollection.find({ _id: { $in: templateIds } }).toArray();

      // Merge embedding metadata with template data
      const results = templates.map(template => {
        const embeddingResult = embeddingResults.find(r => r._id === template._id);
        return {
          ...template,
          metaData: embeddingResult.metaData,
          score: embeddingResult.score
        };
      });

      res.json({
        success: true,
        results
      });
    } else {
      // If no query, just filter by industry and style
      const results = await templatesCollection.find(filter)
        .limit(parseInt(limit))
        .toArray();

      res.json({
        success: true,
        results
      });
    }
  } catch (error) {
    console.error('Error searching templates:', error);
    res.status(500).json({
      success: false,
      message: 'Error searching templates',
      error: error.message
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
});

// Helper functions for RAG
function extractRequirements(userRequest) {
  // Extract key requirements from user request
  const requirements = {
    industry: null,
    style: null,
    features: [],
    pages: []
  };

  // Industry detection
  const industries = [
    'realestate', 'restaurant', 'education', 'ecommerce',
    'health', 'business', 'portfolio', 'travel'
  ];

  for (const industry of industries) {
    if (userRequest.toLowerCase().includes(industry)) {
      requirements.industry = industry;
      break;
    }
  }

  // Style detection
  const styles = [
    'modern', 'minimalist', 'elegant', 'creative',
    'corporate', 'classic', 'dark', 'light'
  ];

  for (const style of styles) {
    if (userRequest.toLowerCase().includes(style)) {
      requirements.style = style;
      break;
    }
  }

  // Feature detection
  const featureKeywords = {
    'contact form': 'contact',
    'map': 'map',
    'contact': 'contact',
    'reservation': 'reservation',
    'booking': 'reservation',
    'menu': 'restaurant-menu',
    'gallery': 'gallery',
    'testimonial': 'testimonials',
    'review': 'testimonials',
    'slider': 'carousel',
    'carousel': 'carousel',
    'product': 'products',
    'shop': 'ecommerce',
    'portfolio': 'portfolio',
    'blog': 'blog'
  };

  Object.entries(featureKeywords).forEach(([keyword, feature]) => {
    if (userRequest.toLowerCase().includes(keyword)) {
      requirements.features.push(feature);
    }
  });

  // Page type detection
  const pageKeywords = {
    'home': 'homepage',
    'about': 'about',
    'contact': 'contact',
    'service': 'services',
    'product': 'products',
    'portfolio': 'portfolio',
    'blog': 'blog',
    'pricing': 'pricing'
  };

  Object.entries(pageKeywords).forEach(([keyword, page]) => {
    if (userRequest.toLowerCase().includes(keyword + ' page')) {
      requirements.pages.push(page);
    }
  });

  return requirements;
}

function generateComponentQueries(requirements) {
  const queries = {};
  const componentTypes = [
    'header', 'footer', 'hero', 'features',
    'testimonials', 'contact', 'blog', 'team'
  ];

  // Generate a query for each component type
  componentTypes.forEach(type => {
    let query = type;

    if (requirements.industry) {
      query += ` ${requirements.industry}`;
    }

    if (requirements.style) {
      query += ` ${requirements.style}`;
    }

    // Add relevant feature terms
    if (type === 'hero' && requirements.features.includes('carousel')) {
      query += ' carousel slider';
    }

    if (type === 'contact' && requirements.features.includes('map')) {
      query += ' map location';
    }

    queries[type] = query;
  });

  // Add queries for specifically requested features
  requirements.features.forEach(feature => {
    if (!Object.values(queries).some(q => q.includes(feature))) {
      queries[feature] = `${feature} ${requirements.industry || ''} ${requirements.style || ''}`;
    }
  });

  return queries;
}

function generateTemplateQuery(requirements) {
  let query = '';

  if (requirements.industry) {
    query += requirements.industry;
  }

  if (requirements.style) {
    query += ` ${requirements.style}`;
  }

  // Add top 3 features to the query
  const topFeatures = requirements.features.slice(0, 3);
  if (topFeatures.length > 0) {
    query += ` ${topFeatures.join(' ')}`;
  }

  return query.trim();
}

function formatRetrievedDataForLLM(userRequest, retrievedComponents, retrievedTemplate) {
  let context = "# Retrieved Website Design References\n\n";

  // Add template information if available
  if (retrievedTemplate) {
    context += "## Template Overview\n\n";
    context += `Template Name: ${retrievedTemplate.name}\n`;
    context += `Industry: ${retrievedTemplate.industry}\n`;
    context += `Style: ${retrievedTemplate.styleType}\n`;
    if (retrievedTemplate.metaData) {
      context += `Key Features: ${retrievedTemplate.metaData.keyFeatures}\n`;
      context += `Best Used For: ${retrievedTemplate.metaData.bestUsedFor}\n`;
      context += `Color Scheme: ${retrievedTemplate.metaData.colorScheme}\n`;
      context += `Layout Pattern: ${retrievedTemplate.metaData.layoutPattern}\n`;
    }
    context += "\n";
  }

  // Group components by type
  const componentsByType = {};
  retrievedComponents.forEach(component => {
    if (!componentsByType[component.type]) {
      componentsByType[component.type] = [];
    }
    componentsByType[component.type].push(component);
  });

  // Format each group for the LLM
  Object.entries(componentsByType).forEach(([type, components]) => {
    context += `## ${capitalize(type)} Components\n\n`;

    components.slice(0, 2).forEach((component, index) => {
      context += `### Example ${index + 1}: ${component.name}\n`;

      if (component.useCaseInfo) {
        context += `Suitable For: ${component.useCaseInfo.suitability}\n`;
        context += `Customization Options: ${component.useCaseInfo.customizationOptions}\n`;
      }

      context += "```html\n";

      // Truncate HTML if too long (for LLM context window management)
      const maxHtmlLength = 1000;
      if (component.html.length > maxHtmlLength) {
        context += component.html.substring(0, maxHtmlLength) + "\n<!-- HTML truncated for brevity -->";
      } else {
        context += component.html;
      }

      context += "\n```\n\n";

      if (component.css) {
        context += "```css\n";

        // Truncate CSS if too long
        const maxCssLength = 500;
        if (component.css.length > maxCssLength) {
          context += component.css.substring(0, maxCssLength) + "\n/* CSS truncated for brevity */";
        } else {
          context += component.css;
        }

        context += "\n```\n\n";
      }
    });
  });

  return context;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// POST /api/rag-website-generation - Generate website using RAG
app.post('/api/rag-website-generation', async (req, res) => {
  try {
    const { userPrompt, llmApiKey } = req.body;

    if (!userPrompt) {
      return res.status(400).json({
        success: false,
        message: 'User prompt is required'
      });
    }


    // Process user request to requirements
    const requirements = extractRequirements(userPrompt);
    console.log("1", requirements)

    // Generate component queries
    const componentQueries = generateComponentQueries(requirements);
    console.log("2", componentQueries)
    // Generate template query
    const templateQuery = generateTemplateQuery(requirements);
    console.log("3", templateQuery)
    // Retrieve components for each component type
    const retrievedComponents = [];
    for (const [type, query] of Object.entries(componentQueries)) {
      const response = await axios.get(`${req.protocol}://${req.get('host')}/api/search-components`, {
        params: {
          query,
          type: type.includes('-') ? undefined : type, // Don't filter by type if it's a compound type
          industry: requirements.industry,
          limit: 2
        }
      });

      if (response.data.success && response.data.results.length > 0) {
        retrievedComponents.push(...response.data.results);
      }
    }
    console.log("4", retrievedComponents)
    // Retrieve template
    let retrievedTemplate = null;
    if (templateQuery) {
      const response = await axios.get(`${req.protocol}://${req.get('host')}/api/search-templates`, {
        params: {
          query: templateQuery,
          industry: requirements.industry,
          style: requirements.style,
          limit: 1
        }
      });

      if (response.data.success && response.data.results.length > 0) {
        retrievedTemplate = response.data.results[0];
      }
    }

    // Format for LLM
    const formattedContext = formatRetrievedDataForLLM(
      userPrompt,
      retrievedComponents,
      retrievedTemplate
    );

    // Construct prompt for LLM
    const llmPrompt = `
      You are a website generation assistant that creates HTML, CSS, and JavaScript code based on user requirements.
      
      USER REQUEST: ${userPrompt}
      
      REFERENCE COMPONENTS AND TEMPLATES:
      ${formattedContext}
      
      INSTRUCTIONS:
      1. Create a complete website that fulfills the user's requirements
      2. Use the reference components as inspiration and templates
      3. Adapt the components to ensure consistent styling and functionality
      4. Ensure all components work together cohesively
      5. Maintain the best practices from the reference components
      6. Return a complete, ready-to-use website with HTML, CSS, and JavaScript
      
      Your response should have the following structure:
      1. A brief explanation of your approach
      2. The complete HTML code
      3. The complete CSS code
      4. Any required JavaScript code
    `;

    console.log("5", llmPrompt)
    // In a real implementation, you would call an LLM API here
    // For now, we'll just return a structured response with the gathered data
    const generatedWebsite = {
      explanation: "This is where the LLM would explain its approach",
      html: "<!DOCTYPE html>\n<html>...</html>",
      css: "body { ... }",
      javascript: "// JavaScript code"
    };

    res.json({
      success: true,
      requirements,
      retrievedComponentsCount: retrievedComponents.length,
      hasTemplateReference: retrievedTemplate !== null,
      generatedWebsite,
      // Include the following in development mode only
      ...(debugMode ? {
        componentQueries,
        templateQuery,
        context: formattedContext
      } : {})
    });
  } catch (error) {
    console.error('Error in RAG website generation:', error);
    res.status(500).json({
      success: false,
      message: 'Error in RAG website generation',
      error: error.message
    });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});