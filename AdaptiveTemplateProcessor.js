// AdaptiveTemplateProcessor.js
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios'); // Replace OpenAI with axios for Ollama API calls
const { MongoClient } = require('mongodb');
const sharp = require('sharp');
const glob = require('glob');

class AdaptiveTemplateProcessor {
  constructor(config = {}) {
    this.templatesDir = config.templatesDir || path.join(__dirname, 'uploads');
    this.outputDir = config.outputDir || path.join(__dirname, 'extracted_templates');
    this.assetsDir = config.assetsDir || path.join(__dirname, 'public', 'assets');
    this.mongoUri = config.mongoUri || 'mongodb://localhost:27017';
    this.dbName = config.dbName || 'template_vector_db';
    
    // Ollama configuration
    this.ollamaUrl = config.ollamaUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.ollamaModel = config.ollamaModel || process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
    
    this.ensureDirectoryExists(this.templatesDir);
    this.ensureDirectoryExists(this.outputDir);
    this.ensureDirectoryExists(this.assetsDir);
    
    // Template structure patterns that we recognize
    this.knownStructures = [
      {
        name: 'standard',
        detectFn: (files) => files.some(f => f.includes('index.html') || f.includes('home.html')),
        cssPatterns: ['css/', 'assets/css/'],
        jsPatterns: ['js/', 'assets/js/'],
        imagePatterns: ['images/', 'assets/images/', 'img/', 'assets/img/']
      },
      {
        name: 'bootstrap-based',
        detectFn: (files) => files.some(f => f.includes('bootstrap')),
        cssPatterns: ['css/', 'dist/css/', 'vendor/bootstrap/css/'],
        jsPatterns: ['js/', 'dist/js/', 'vendor/bootstrap/js/'],
        imagePatterns: ['images/', 'img/', 'assets/images/']
      },
      {
        name: 'wordpress-theme',
        detectFn: (files) => files.some(f => f.includes('style.css') && (f.includes('functions.php') || f.includes('index.php'))),
        cssPatterns: ['./', 'css/', 'assets/css/'],
        jsPatterns: ['js/', 'assets/js/'],
        imagePatterns: ['images/', 'img/', 'assets/images/']
      }
    ];
    
    // Initialize event emitters and callbacks
    this.eventCallbacks = {
      'progress': [],
      'complete': [],
      'error': []
    };
  }

  // Event handling for progress updates
  on(event, callback) {
    if (this.eventCallbacks[event]) {
      this.eventCallbacks[event].push(callback);
    }
    return this;
  }
  
  emit(event, data) {
    if (this.eventCallbacks[event]) {
      this.eventCallbacks[event].forEach(callback => callback(data));
    }
  }

  ensureDirectoryExists(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Method to generate embeddings using Ollama API
  async generateOllamaEmbedding(text) {
    try {
      const response = await axios.post(`${this.ollamaUrl}/api/embeddings`, {
        model: this.ollamaModel,
        prompt: text
      });
      
      // Extract embedding from response
      if (response.data && response.data.embedding) {
        return response.data.embedding;
      } else {
        throw new Error('Invalid response from Ollama API');
      }
    } catch (error) {
      console.error('Error generating embedding with Ollama:', error);
      // Return empty array as fallback
      return [];
    }
  }

  async processTemplateZip(zipFilePath, options = {}) {
    const zipFileName = path.basename(zipFilePath);
    this.emit('progress', {
      status: 'starting',
      message: `Starting to process ${zipFileName}`,
      progress: 0
    });
    
    try {
      const zip = new AdmZip(zipFilePath);
      const entries = zip.getEntries();
      
      // Get all file paths in the zip
      const allFiles = entries.map(entry => entry.entryName);
      
      this.emit('progress', {
        status: 'extracting',
        message: `Extracting files from ${zipFileName}`,
        progress: 10
      });
      
      // Extract template metadata
      const templateInfo = this.extractTemplateInfo(zipFileName, zip);
      
      // Create extraction directory for this template
      const extractDir = path.join(this.outputDir, templateInfo.id);
      this.ensureDirectoryExists(extractDir);
      
      // Extract ZIP contents
      zip.extractAllTo(extractDir, true);
      
      this.emit('progress', {
        status: 'analyzing_structure',
        message: `Analyzing template structure`,
        progress: 20
      });
      
      // Detect template structure
      const structure = this.detectTemplateStructure(allFiles, extractDir);
      console.log(`Detected structure: ${structure.name} for ${zipFileName}`);
      
      // Find HTML files
      const htmlFiles = this.findFiles(extractDir, '.html');
      
      this.emit('progress', {
        status: 'processing_css',
        message: `Processing CSS files`,
        progress: 30
      });
      
      // Find and load CSS files
      const cssFiles = this.findCssFiles(extractDir, structure);
      const cssContent = this.loadCssFiles(cssFiles);
      
      this.emit('progress', {
        status: 'processing_images',
        message: `Processing image assets`,
        progress: 40
      });
      
      // Process image assets to create a mapping of relative URLs
      const imageMap = await this.processImageAssets(extractDir, structure, templateInfo);
      
      this.emit('progress', {
        status: 'extracting_components',
        message: `Extracting components from HTML`,
        progress: 50
      });
      
      // Extract components from HTML files
      const components = await this.extractComponentsFromHtml(
        htmlFiles, 
        cssContent, 
        templateInfo,
        structure,
        imageMap
      );
      
      this.emit('progress', {
        status: 'generating_embeddings',
        message: `Generating vector embeddings`,
        progress: 70
      });
      
      // Generate embeddings for each component
      const componentsWithEmbeddings = await this.generateEmbeddings(components);
      
      this.emit('progress', {
        status: 'storing_database',
        message: `Storing components in vector database`,
        progress: 90
      });
      
      // Store in MongoDB
      if (!options.skipDatabaseStorage) {
        await this.storeComponentsInDatabase(componentsWithEmbeddings);
      }
      
      this.emit('progress', {
        status: 'completed',
        message: `Processing complete for ${zipFileName}`,
        progress: 100
      });
      
      this.emit('complete', {
        templateId: templateInfo.id,
        componentCount: componentsWithEmbeddings.length
      });
      
      return {
        templateInfo,
        components: componentsWithEmbeddings
      };
    } catch (error) {
      console.error(`Error processing template ${zipFilePath}:`, error);
      this.emit('error', {
        error: error.message,
        templatePath: zipFilePath
      });
      throw error;
    }
  }

  detectTemplateStructure(files, extractDir) {
    // Try to match against known structures
    for (const structure of this.knownStructures) {
      if (structure.detectFn(files)) {
        return structure;
      }
    }
    
    // If no match, analyze the directory structure to create a custom structure
    return this.analyzeDirectoryStructure(extractDir, files);
  }

  analyzeDirectoryStructure(extractDir, files) {
    // Base structure
    const structure = {
      name: 'custom',
      cssPatterns: [],
      jsPatterns: [],
      imagePatterns: []
    };
    
    // Find CSS directories
    const possibleCssDirs = files.filter(f => f.includes('/css/') || f.endsWith('.css'))
                                 .map(f => path.dirname(f))
                                 .filter(Boolean);
    
    if (possibleCssDirs.length > 0) {
      // Get the most common directories
      const cssDirs = this.getMostCommonPaths(possibleCssDirs);
      structure.cssPatterns = cssDirs.map(d => d + '/');
    } else {
      structure.cssPatterns = ['css/', 'assets/css/'];  // Default
    }
    
    // Find JS directories
    const possibleJsDirs = files.filter(f => f.includes('/js/') || f.endsWith('.js'))
                                .map(f => path.dirname(f))
                                .filter(Boolean);
    
    if (possibleJsDirs.length > 0) {
      const jsDirs = this.getMostCommonPaths(possibleJsDirs);
      structure.jsPatterns = jsDirs.map(d => d + '/');
    } else {
      structure.jsPatterns = ['js/', 'assets/js/'];  // Default
    }
    
    // Find image directories
    const possibleImgDirs = files.filter(f => 
                                    f.includes('/images/') || 
                                    f.includes('/img/') || 
                                    /\.(jpg|jpeg|png|gif|svg)$/i.test(f))
                                 .map(f => path.dirname(f))
                                 .filter(Boolean);
    
    if (possibleImgDirs.length > 0) {
      const imgDirs = this.getMostCommonPaths(possibleImgDirs);
      structure.imagePatterns = imgDirs.map(d => d + '/');
    } else {
      structure.imagePatterns = ['images/', 'img/', 'assets/images/'];  // Default
    }
    
    return structure;
  }

  getMostCommonPaths(paths) {
    const counts = {};
    
    // Count occurrences of each path
    for (const p of paths) {
      counts[p] = (counts[p] || 0) + 1;
    }
    
    // Sort by count and take the top 3
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([path]) => path);
  }

  findFiles(dir, extension) {
    if (!fs.existsSync(dir)) {
      return [];
    }
    
    try {
      // Use glob for recursive search
      return glob.sync(`${dir}/**/*${extension}`);
    } catch (error) {
      console.error(`Error finding files with extension ${extension}:`, error);
      return [];
    }
  }

  findCssFiles(extractDir, structure) {
    let cssFiles = [];
    
    // Look in all possible CSS locations according to the structure
    for (const pattern of structure.cssPatterns) {
      const patternPath = path.join(extractDir, pattern);
      if (fs.existsSync(patternPath) && fs.statSync(patternPath).isDirectory()) {
        const files = this.findFiles(patternPath, '.css');
        cssFiles = cssFiles.concat(files);
      }
    }
    
    // If no CSS files found in standard locations, search the entire directory
    if (cssFiles.length === 0) {
      cssFiles = this.findFiles(extractDir, '.css');
    }
    
    return cssFiles;
  }

  loadCssFiles(cssFiles) {
    const cssContent = {};
    
    for (const cssFile of cssFiles) {
      try {
        const content = fs.readFileSync(cssFile, 'utf8');
        cssContent[cssFile] = content;
      } catch (error) {
        console.warn(`Error reading CSS file ${cssFile}:`, error);
      }
    }
    
    return cssContent;
  }

  async processImageAssets(extractDir, structure, templateInfo) {
    let imageFiles = [];
    
    // Look in all possible image locations according to the structure
    for (const pattern of structure.imagePatterns) {
      const patternPath = path.join(extractDir, pattern);
      if (fs.existsSync(patternPath) && fs.statSync(patternPath).isDirectory()) {
        const files = this.findImageFiles(patternPath);
        imageFiles = imageFiles.concat(files);
      }
    }
    
    // If no images found in standard locations, search the entire directory
    if (imageFiles.length === 0) {
      imageFiles = this.findImageFiles(extractDir);
    }
    
    // Create assets directory and build path mapping
    const assetsDir = path.join(this.assetsDir, templateInfo.id);
    this.ensureDirectoryExists(assetsDir);
    
    const imageMap = {};
    
    for (const imagePath of imageFiles) {
      try {
        const fileName = path.basename(imagePath);
        const destPath = path.join(assetsDir, fileName);
        
        // Process and optimize the image
        await this.optimizeAndSaveImage(imagePath, destPath);
        
        // Store the mapping - both absolute and relative paths
        const relativePath = path.relative(extractDir, imagePath).replace(/\\/g, '/');
        imageMap[relativePath] = `/assets/${templateInfo.id}/${fileName}`;
        imageMap[fileName] = `/assets/${templateInfo.id}/${fileName}`;
        
        // Handle paths with or without leading slash
        if (relativePath.startsWith('/')) {
          imageMap[relativePath.substring(1)] = `/assets/${templateInfo.id}/${fileName}`;
        } else {
          imageMap['/' + relativePath] = `/assets/${templateInfo.id}/${fileName}`;
        }
      } catch (error) {
        console.warn(`Error processing image ${imagePath}:`, error);
      }
    }
    
    return imageMap;
  }

  async optimizeAndSaveImage(sourceImagePath, destImagePath) {
    try {
      const imageExt = path.extname(sourceImagePath).toLowerCase();
      
      // Skip SVG files - no need to process them with sharp
      if (imageExt === '.svg') {
        fs.copyFileSync(sourceImagePath, destImagePath);
        return;
      }
      
      // For other image types, use sharp to optimize
      await sharp(sourceImagePath)
        .resize(1200, 1200, { 
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: 85, progressive: true })
        .toFile(destImagePath);
    } catch (error) {
      console.warn(`Error optimizing image ${sourceImagePath}:`, error);
      // Fallback to direct copy if optimization fails
      fs.copyFileSync(sourceImagePath, destImagePath);
    }
  }

  findImageFiles(dir) {
    return [
      ...this.findFiles(dir, '.jpg'),
      ...this.findFiles(dir, '.jpeg'),
      ...this.findFiles(dir, '.png'),
      ...this.findFiles(dir, '.gif'),
      ...this.findFiles(dir, '.svg')
    ];
  }

  extractTemplateInfo(filename, zip) {
    // Try to find template info file first
    const infoEntry = zip.getEntries().find(entry => 
      entry.name === 'template-info.json' || 
      entry.name === 'config.json' ||
      entry.name.endsWith('info.json')
    );
    
    if (infoEntry) {
      try {
        const infoContent = infoEntry.getData().toString('utf8');
        const info = JSON.parse(infoContent);
        return {
          id: info.id || `template-${uuidv4().substring(0, 8)}`,
          name: info.name || this.getNameFromFilename(filename),
          industry: info.industry || this.detectIndustryFromFilename(filename),
          styleType: info.styleType || this.detectStyleFromFilename(filename),
          description: info.description || '',
          tags: info.tags || []
        };
      } catch (error) {
        console.warn(`Error parsing template info from ${filename}:`, error);
      }
    }
    
    // Also try to parse metadata from comments in HTML files
    const htmlEntry = zip.getEntries().find(entry => 
      entry.name === 'index.html' || 
      entry.name.endsWith('/index.html')
    );
    
    if (htmlEntry) {
      try {
        const htmlContent = htmlEntry.getData().toString('utf8');
        const metaInfo = this.extractMetadataFromHtml(htmlContent);
        
        if (metaInfo && Object.keys(metaInfo).length > 0) {
          return {
            id: metaInfo.id || `template-${uuidv4().substring(0, 8)}`,
            name: metaInfo.name || this.getNameFromFilename(filename),
            industry: metaInfo.industry || this.detectIndustryFromFilename(filename),
            styleType: metaInfo.styleType || this.detectStyleFromFilename(filename),
            description: metaInfo.description || '',
            tags: metaInfo.tags || []
          };
        }
      } catch (error) {
        console.warn(`Error extracting metadata from HTML in ${filename}:`, error);
      }
    }
    
    // Fallback to deriving info from filename
    return {
      id: `template-${uuidv4().substring(0, 8)}`,
      name: this.getNameFromFilename(filename),
      industry: this.detectIndustryFromFilename(filename),
      styleType: this.detectStyleFromFilename(filename),
      description: `Template extracted from ${filename}`,
      tags: this.generateTagsFromFilename(filename)
    };
  }

  extractMetadataFromHtml(html) {
    // Look for metadata in HTML comments or meta tags
    const metaCommentRegex = /<!--\s*TEMPLATE\s*METADATA\s*:\s*({[\s\S]*?})\s*-->/i;
    const metaMatch = html.match(metaCommentRegex);
    
    if (metaMatch && metaMatch[1]) {
      try {
        return JSON.parse(metaMatch[1]);
      } catch (e) {
        console.warn('Failed to parse template metadata from HTML comment:', e);
      }
    }
    
    // Try to extract from meta tags
    const $ = cheerio.load(html);
    const metadata = {};
    
    $('meta').each((i, el) => {
      const name = $(el).attr('name');
      const content = $(el).attr('content');
      
      if (name && content) {
        if (name.startsWith('template:')) {
          const key = name.replace('template:', '');
          metadata[key] = content;
        }
      }
    });
    
    // Look for title tag for name
    const title = $('title').text();
    if (title && !metadata.name) {
      metadata.name = title;
    }
    
    return metadata;
  }

  getNameFromFilename(filename) {
    // Extract name from filename
    const baseName = path.basename(filename, '.zip');
    
    // Remove version numbers, underscores, etc.
    const cleanName = baseName
      .replace(/[-_]/g, ' ')
      .replace(/\d+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Capitalize words
    return cleanName
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  detectIndustryFromFilename(filename) {
    const lowercaseFilename = filename.toLowerCase();
    
    const industryKeywords = {
      'realestate': ['realestate', 'property', 'estate', 'homes', 'villa', 'apartment'],
      'restaurant': ['restaurant', 'food', 'cafe', 'dining', 'kitchen'],
      'education': ['education', 'school', 'learning', 'course', 'teaching', 'class', 'academy'],
      'ecommerce': ['ecommerce', 'shop', 'store', 'market', 'retail', 'product'],
      'health': ['health', 'medical', 'doctor', 'hospital', 'clinic', 'wellness'],
      'business': ['business', 'corporate', 'company', 'agency', 'consulting'],
      'portfolio': ['portfolio', 'resume', 'cv', 'profile'],
      'travel': ['travel', 'tourism', 'hotel', 'vacation', 'tour']
    };
    
    for (const [industry, keywords] of Object.entries(industryKeywords)) {
      if (keywords.some(keyword => lowercaseFilename.includes(keyword))) {
        return industry;
      }
    }
    
    return 'general';
  }

  detectStyleFromFilename(filename) {
    const lowercaseFilename = filename.toLowerCase();
    
    const styleKeywords = {
      'modern': ['modern', 'contemporary', 'fresh', 'clean'],
      'minimalist': ['minimalist', 'minimal', 'simple', 'clean'],
      'elegant': ['elegant', 'luxury', 'premium', 'sophisticated'],
      'creative': ['creative', 'colorful', 'artistic', 'bold'],
      'corporate': ['corporate', 'professional', 'business', 'formal'],
      'classic': ['classic', 'traditional', 'vintage', 'retro']
    };
    
    for (const [style, keywords] of Object.entries(styleKeywords)) {
      if (keywords.some(keyword => lowercaseFilename.includes(keyword))) {
        return style;
      }
    }
    
    return 'modern'; // Default
  }

  generateTagsFromFilename(filename) {
    const nameParts = path.basename(filename, '.zip')
      .replace(/[-_]/g, ' ')
      .split(' ')
      .filter(p => p.length > 2); // Filter out short parts
    
    // Add numerical values (likely template numbers) to tags
    const numericalParts = path.basename(filename, '.zip')
      .match(/\d+/g) || [];
    
    return [...new Set([...nameParts, ...numericalParts])];
  }

  async extractComponentsFromHtml(htmlFiles, cssContent, templateInfo, structure, imageMap) {
    const components = [];
    const cssString = Object.values(cssContent).join('\n');
    
    for (const file of htmlFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const $ = cheerio.load(content);
        
        // Update all image paths in the HTML
        this.updateImagePaths($, imageMap);
        
        // Extract components by type
        this.extractHeaderComponents($, file, cssString, templateInfo, components);
        this.extractFooterComponents($, file, cssString, templateInfo, components);
        this.extractHeroComponents($, file, cssString, templateInfo, components);
        this.extractFeatureSections($, file, cssString, templateInfo, components);
        this.extractTestimonialSections($, file, cssString, templateInfo, components);
        this.extractContactForms($, file, cssString, templateInfo, components);
        this.extractCardSections($, file, cssString, templateInfo, components);
        
        // Extract any industry-specific components
        this.extractIndustrySpecificComponents($, file, cssString, templateInfo, components);
        
      } catch (error) {
        console.warn(`Error processing HTML file ${file}:`, error);
      }
    }
    
    return components;
  }

  updateImagePaths($, imageMap) {
    // Update src attributes
    $('img, source').each((i, el) => {
      const src = $(el).attr('src');
      if (src && imageMap[src]) {
        $(el).attr('src', imageMap[src]);
      }
    });
    
    // Update style attributes with background images
    $('[style*="background"]').each((i, el) => {
      const style = $(el).attr('style');
      if (style) {
        let updatedStyle = style;
        
        // Find all background image URLs
        const urlRegex = /url\(['"]?([^'"()]+)['"]?\)/g;
        let match;
        
        while ((match = urlRegex.exec(style)) !== null) {
          const originalUrl = match[1];
          if (imageMap[originalUrl]) {
            updatedStyle = updatedStyle.replace(originalUrl, imageMap[originalUrl]);
          }
        }
        
        $(el).attr('style', updatedStyle);
      }
    });
    
    return $;
  }

  extractHeaderComponents($, file, cssString, templateInfo, components) {
    // Common selectors for headers
    const headerSelectors = [
      'header',
      '.header',
      '.site-header',
      '.main-header',
      '#header',
      'nav.navbar',
      '.navbar-header',
      '.navigation'
    ];
    
    let headerFound = false;
    
    for (const selector of headerSelectors) {
      const headerElements = $(selector);
      if (headerElements.length > 0) {
        headerElements.each((i, element) => {
          const componentId = `header-${uuidv4().substring(0, 8)}`;
          const headerHtml = $(element).clone().wrap('<div>').parent().html();
          
          // Extract relevant CSS for this header
          const extractedCss = this.extractRelevantCss(cssString, selector);
          
          const headerComponent = {
            id: componentId,
            type: 'header',
            name: `${templateInfo.name} Header`,
            html: headerHtml,
            css: extractedCss,
            sourceFile: path.basename(file),
            templateId: templateInfo.id,
            industry: templateInfo.industry,
            styleType: templateInfo.styleType,
            attributes: {
              hasLogo: headerHtml.includes('logo'),
              hasSearch: headerHtml.includes('search'),
              hasNavigation: headerHtml.includes('nav') || headerHtml.includes('menu'),
              hasDropdown: headerHtml.includes('dropdown'),
              isSticky: headerHtml.includes('sticky') || extractedCss.includes('position: fixed') || extractedCss.includes('position:fixed')
            }
          };
          
          components.push(headerComponent);
          headerFound = true;
        });
      }
    }
    
    // If no header found, try to extract the top section of the page
    if (!headerFound && path.basename(file) === 'index.html') {
      const bodyChildren = $('body').children();
      if (bodyChildren.length > 0) {
        // Get the first significant element (not a comment, script, etc.)
        let headerCandidate = null;
        
        for (let i = 0; i < Math.min(5, bodyChildren.length); i++) {
          const element = bodyChildren[i];
          const tagName = element.tagName;
          
          if (tagName && !['SCRIPT', 'STYLE', 'LINK', 'META', '#comment'].includes(tagName)) {
            headerCandidate = element;
            break;
          }
        }
        
        if (headerCandidate) {
          const componentId = `header-${uuidv4().substring(0, 8)}`;
          const headerHtml = $(headerCandidate).clone().wrap('<div>').parent().html();
          
          // Extract relevant CSS
          const selector = headerCandidate.tagName.toLowerCase() + 
                          (headerCandidate.id ? `#${headerCandidate.id}` : '') +
                          (headerCandidate.className ? `.${headerCandidate.className.replace(/\s+/g, '.')}` : '');
          
          const extractedCss = this.extractRelevantCss(cssString, selector);
          
          const headerComponent = {
            id: componentId,
            type: 'header',
            name: `${templateInfo.name} Top Section`,
            html: headerHtml,
            css: extractedCss,
            sourceFile: path.basename(file),
            templateId: templateInfo.id,
            industry: templateInfo.industry,
            styleType: templateInfo.styleType,
            attributes: {
              isAssumed: true,
              hasLogo: headerHtml.includes('logo'),
              hasNavigation: headerHtml.includes('nav') || headerHtml.includes('menu')
            }
          };
          
          components.push(headerComponent);
        }
      }
    }
  }

  extractFooterComponents($, file, cssString, templateInfo, components) {
    // Common selectors for footers
    const footerSelectors = [
      'footer',
      '.footer',
      '.site-footer',
      '.main-footer',
      '#footer',
      '.footer-area',
      '.footer-section'
    ];
    
    let footerFound = false;
    
    for (const selector of footerSelectors) {
      const footerElements = $(selector);
      if (footerElements.length > 0) {
        footerElements.each((i, element) => {
          const componentId = `footer-${uuidv4().substring(0, 8)}`;
          const footerHtml = $(element).clone().wrap('<div>').parent().html();
          
          // Extract relevant CSS for this footer
          const extractedCss = this.extractRelevantCss(cssString, selector);
          
          const footerComponent = {
            id: componentId,
            type: 'footer',
            name: `${templateInfo.name} Footer`,
            html: footerHtml,
            css: extractedCss,
            sourceFile: path.basename(file),
            templateId: templateInfo.id,
            industry: templateInfo.industry,
            styleType: templateInfo.styleType,
            attributes: {
              hasSocialLinks: footerHtml.includes('social') || 
                              footerHtml.includes('facebook') || 
                              footerHtml.includes('twitter') || 
                              footerHtml.includes('instagram'),
              hasMultiColumn: $(element).find('div.col, div.column').length > 1,
              hasContactInfo: footerHtml.includes('contact') || 
                              footerHtml.includes('email') || 
                              footerHtml.includes('phone'),
              hasNewsletter: footerHtml.includes('newsletter') || 
                             footerHtml.includes('subscribe')
            }
          };
          
          components.push(footerComponent);
          footerFound = true;
        });
      }
    }
    
    // If no footer found, try to extract the bottom section of the page
    if (!footerFound && path.basename(file) === 'index.html') {
      const bodyChildren = $('body').children();
      if (bodyChildren.length > 0) {
        // Get the last significant element
        let footerCandidate = null;
        
        for (let i = bodyChildren.length - 1; i >= Math.max(0, bodyChildren.length - 5); i--) {
          const element = bodyChildren[i];
          const tagName = element.tagName;
          
          if (tagName && !['SCRIPT', 'STYLE', 'LINK', 'META', '#comment'].includes(tagName)) {
            footerCandidate = element;
            break;
          }
        }
        
        if (footerCandidate) {
          const componentId = `footer-${uuidv4().substring(0, 8)}`;
          const footerHtml = $(footerCandidate).clone().wrap('<div>').parent().html();
          
          // Extract relevant CSS
          const selector = footerCandidate.tagName.toLowerCase() + 
                          (footerCandidate.id ? `#${footerCandidate.id}` : '') +
                          (footerCandidate.className ? `.${footerCandidate.className.replace(/\s+/g, '.')}` : '');
          
          const extractedCss = this.extractRelevantCss(cssString, selector);
          
          const footerComponent = {
            id: componentId,
            type: 'footer',
            name: `${templateInfo.name} Bottom Section`,
            html: footerHtml,
            css: extractedCss,
            sourceFile: path.basename(file),
            templateId: templateInfo.id,
            industry: templateInfo.industry,
            styleType: templateInfo.styleType,
            attributes: {
              isAssumed: true,
              hasCopyright: footerHtml.includes('copyright') || footerHtml.includes('&copy;')
            }
          };
          
          components.push(footerComponent);
        }
      }
    }
  }

  extractHeroComponents($, file, cssString, templateInfo, components) {
    // Common selectors for hero sections
    const heroSelectors = [
      '.hero',
      '.hero-section',
      '.banner',
      '.banner-section',
      '.main-banner',
      '.jumbotron',
      '.carousel',
      '.slider',
      '.intro',
      '.intro-section',
      '.header-content',
      '.cta-banner',
      '.welcome-area',
      '#hero',
      '#banner'
    ];
    
    for (const selector of heroSelectors) {
      const heroElements = $(selector);
      if (heroElements.length > 0) {
        heroElements.each((i, element) => {
          const componentId = `hero-${uuidv4().substring(0, 8)}`;
          const heroHtml = $(element).clone().wrap('<div>').parent().html();
          
          // Extract relevant CSS for this hero
          const extractedCss = this.extractRelevantCss(cssString, selector);
          
          // Look for background image in the hero section
          let hasBackgroundImage = false;
          const style = $(element).attr('style');
          if (style && style.includes('background')) {
            hasBackgroundImage = true;
          } else {
            // Check child elements for background images
            $(element).find('*[style*="background"]').each((i, el) => {
              hasBackgroundImage = true;
            });
          }
          
          const heroComponent = {
            id: componentId,
            type: 'hero',
            name: `${templateInfo.name} Hero Section`,
            html: heroHtml,
            css: extractedCss,
            sourceFile: path.basename(file),
            templateId: templateInfo.id,
            industry: templateInfo.industry,
            styleType: templateInfo.styleType,
            attributes: {
              hasButton: $(element).find('button, .btn, a.button').length > 0,
              hasImage: $(element).find('img').length > 0 || hasBackgroundImage,
              hasHeading: $(element).find('h1, h2, h3').length > 0,
              isFullscreen: extractedCss.includes('height: 100vh') || 
                            extractedCss.includes('min-height: 100vh') ||
                            heroHtml.includes('fullscreen') ||
                            heroHtml.includes('full-screen'),
              isCarousel: heroHtml.includes('carousel') || 
                          heroHtml.includes('slider') || 
                          heroHtml.includes('slide')
            }
          };
          
          components.push(heroComponent);
        });
      }
    }
    
    // If no hero found with common selectors but this is index.html, 
    // check for a prominent section at the top (after header)
    if (components.filter(c => c.type === 'hero').length === 0 && path.basename(file) === 'index.html') {
      const header = $('header, .header, #header').first();
      let nextElement = null;
      
      if (header.length > 0) {
        nextElement = header.next();
      } else {
        // If no header found, check the first significant element
        const bodyChildren = $('body').children();
        for (let i = 0; i < bodyChildren.length; i++) {
          const element = bodyChildren[i];
          const tagName = element.tagName;
          
          if (tagName && !['SCRIPT', 'STYLE', 'LINK', 'META', '#comment'].includes(tagName)) {
            // Skip if this is likely a header
            if (i === 0 && (tagName === 'HEADER' || $(element).has('nav').length > 0)) {
              if (i + 1 < bodyChildren.length) {
                nextElement = $(bodyChildren[i + 1]);
              }
            } else {
              nextElement = $(element);
            }
            break;
          }
        }
      }
      
      if (nextElement && nextElement.length > 0) {
        const componentId = `hero-${uuidv4().substring(0, 8)}`;
        const heroHtml = nextElement.clone().wrap('<div>').parent().html();
        
        // Extract relevant CSS
        const selector = nextElement[0].tagName.toLowerCase() + 
                        (nextElement.attr('id') ? `#${nextElement.attr('id')}` : '') +
                        (nextElement.attr('class') ? `.${nextElement.attr('class').replace(/\s+/g, '.')}` : '');
        
        const extractedCss = this.extractRelevantCss(cssString, selector);
        
        let hasBackgroundImage = false;
        const style = nextElement.attr('style');
        if (style && style.includes('background')) {
          hasBackgroundImage = true;
        } else {
          // Check child elements for background images
          nextElement.find('*[style*="background"]').each(() => {
            hasBackgroundImage = true;
          });
        }
        
        const heroComponent = {
          id: componentId,
          type: 'hero',
          name: `${templateInfo.name} Top Section`,
          html: heroHtml,
          css: extractedCss,
          sourceFile: path.basename(file),
          templateId: templateInfo.id,
          industry: templateInfo.industry,
          styleType: templateInfo.styleType,
          attributes: {
            isAssumed: true,
            hasButton: nextElement.find('button, .btn, a.button').length > 0,
            hasImage: nextElement.find('img').length > 0 || hasBackgroundImage,
            hasHeading: nextElement.find('h1, h2, h3').length > 0
          }
        };
        
        components.push(heroComponent);
      }
    }
  }

  extractFeatureSections($, file, cssString, templateInfo, components) {
    // Common selectors for feature sections
    const featureSelectors = [
      '.features',
      '.feature-section',
      '.services',
      '.service-section',
      '.benefits',
      '.highlights',
      '.why-us',
      '.what-we-do',
      '.about-us',
      '.about-section',
      '.process',
      '.process-section',
      '.steps',
      '.how-it-works'
    ];
    
    for (const selector of featureSelectors) {
      const featureElements = $(selector);
      if (featureElements.length > 0) {
        featureElements.each((i, element) => {
          const componentId = `feature-${uuidv4().substring(0, 8)}`;
          const featureHtml = $(element).clone().wrap('<div>').parent().html();
          
          // Extract relevant CSS for this feature section
          const extractedCss = this.extractRelevantCss(cssString, selector);
          
          const featureComponent = {
            id: componentId,
            type: 'features',
            name: `${templateInfo.name} Feature Section`,
            html: featureHtml,
            css: extractedCss,
            sourceFile: path.basename(file),
            templateId: templateInfo.id,
            industry: templateInfo.industry,
            styleType: templateInfo.styleType,
            attributes: {
              hasIcons: $(element).find('i.fa, i.fas, i.fab, i.far, i.icon, .icon, svg').length > 0,
              hasImages: $(element).find('img').length > 0,
              columnCount: this.estimateColumnCount($(element)),
              hasCards: $(element).find('.card, [class*="card"], [class*="box"]').length > 0
            }
          };
          
          components.push(featureComponent);
        });
      }
    }
    
    // Look for sections with card layout that might be feature sections
    if (components.filter(c => c.type === 'features').length === 0) {
      $('section, .section, div.row:has(div.col)').each((i, element) => {
        // Check if this looks like a feature section (contains multiple similar items)
        const cards = $(element).find('.card, [class*="card"], [class*="box"], .col, .column');
        
        if (cards.length >= 2 && cards.length <= 8) {
          // Verify all cards have similar structure (suggesting a feature section)
          const firstCardHtml = $(cards[0]).html();
          const similarCards = Array.from(cards).filter(card => 
            this.calculateTextSimilarity($(card).html(), firstCardHtml) > 0.6
          ).length;
          
          if (similarCards >= 2) {
            const componentId = `feature-${uuidv4().substring(0, 8)}`;
            const featureHtml = $(element).clone().wrap('<div>').parent().html();
            
            // Extract relevant CSS
            const selector = element.tagName.toLowerCase() + 
                            (element.id ? `#${element.id}` : '') +
                            (element.className ? `.${element.className.replace(/\s+/g, '.')}` : '');
            
            const extractedCss = this.extractRelevantCss(cssString, selector);
            
            const featureComponent = {
              id: componentId,
              type: 'features',
              name: `${templateInfo.name} Card Layout Section`,
              html: featureHtml,
              css: extractedCss,
              sourceFile: path.basename(file),
              templateId: templateInfo.id,
              industry: templateInfo.industry,
              styleType: templateInfo.styleType,
              attributes: {
                isAssumed: true,
                hasIcons: $(element).find('i.fa, i.fas, i.fab, i.far, i.icon, .icon, svg').length > 0,
                hasImages: $(element).find('img').length > 0,
                columnCount: cards.length,
                hasCards: true
              }
            };
            
            components.push(featureComponent);
          }
        }
      });
    }
  }

  extractTestimonialSections($, file, cssString, templateInfo, components) {
    // Common selectors for testimonial sections
    const testimonialSelectors = [
      '.testimonials',
      '.testimonial-section',
      '.testimonial',
      '.reviews',
      '.review-section',
      '.quotes',
      '.clients-say',
      '.feedback',
      '#testimonials',
      '[class*="testimonial"]'
    ];
    
    for (const selector of testimonialSelectors) {
      const testimonialElements = $(selector);
      if (testimonialElements.length > 0) {
        testimonialElements.each((i, element) => {
          const componentId = `testimonial-${uuidv4().substring(0, 8)}`;
          const testimonialHtml = $(element).clone().wrap('<div>').parent().html();
          
          // Extract relevant CSS for this testimonial section
          const extractedCss = this.extractRelevantCss(cssString, selector);
          
          const testimonialComponent = {
            id: componentId,
            type: 'testimonials',
            name: `${templateInfo.name} Testimonial Section`,
            html: testimonialHtml,
            css: extractedCss,
            sourceFile: path.basename(file),
            templateId: templateInfo.id,
            industry: templateInfo.industry,
            styleType: templateInfo.styleType,
            attributes: {
              hasAvatar: $(element).find('img').length > 0,
              hasQuotationMarks: testimonialHtml.includes('"') || 
                                 testimonialHtml.includes('"') || 
                                 testimonialHtml.includes('&quot;') ||
                                 testimonialHtml.includes('quote'),
              isCarousel: testimonialHtml.includes('carousel') || 
                          testimonialHtml.includes('slider') || 
                          testimonialHtml.includes('slide'),
              testimonialCount: this.countTestimonials($(element))
            }
          };
          
          components.push(testimonialComponent);
        });
      }
    }
    
    // Look for any sections containing phrases like "what our clients say"
    if (components.filter(c => c.type === 'testimonials').length === 0) {
      $('section, .section, div.container').each((i, element) => {
        const text = $(element).text().toLowerCase();
        if (
          text.includes('testimonial') || 
          text.includes('what our clients say') || 
          text.includes('what people say') || 
          text.includes('customers say') ||
          text.includes('customer reviews') ||
          text.includes('client feedback')
        ) {
          const componentId = `testimonial-${uuidv4().substring(0, 8)}`;
          const testimonialHtml = $(element).clone().wrap('<div>').parent().html();
          
          // Extract relevant CSS
          const selector = element.tagName.toLowerCase() + 
                          (element.id ? `#${element.id}` : '') +
                          (element.className ? `.${element.className.replace(/\s+/g, '.')}` : '');
          
          const extractedCss = this.extractRelevantCss(cssString, selector);
          
          const testimonialComponent = {
            id: componentId,
            type: 'testimonials',
            name: `${templateInfo.name} Testimonial Section`,
            html: testimonialHtml,
            css: extractedCss,
            sourceFile: path.basename(file),
            templateId: templateInfo.id,
            industry: templateInfo.industry,
            styleType: templateInfo.styleType,
            attributes: {
              isAssumed: true,
              hasAvatar: $(element).find('img').length > 0,
              hasQuotationMarks: testimonialHtml.includes('"') || 
                                testimonialHtml.includes('"') || 
                                testimonialHtml.includes('&quot;') ||
                                testimonialHtml.includes('quote')
            }
          };
          
          components.push(testimonialComponent);
        }
      });
    }
  }

  extractContactForms($, file, cssString, templateInfo, components) {
    // Common selectors for contact forms
    const contactSelectors = [
      '.contact-form',
      '.contact-section',
      '.contact-us',
      '.contact',
      '#contact-form',
      '#contact',
      'form[action*="contact"]',
      'form:has(input[name*="email"])',
      '.form-section'
    ];
    
    for (const selector of contactSelectors) {
      const contactElements = $(selector);
      if (contactElements.length > 0) {
        contactElements.each((i, element) => {
          // Check if it's a real contact form (has form elements)
          const formElements = $(element).find('form, input, textarea, select').length;
          if (formElements === 0) {
            return; // Not a form, skip
          }
          
          const componentId = `contact-${uuidv4().substring(0, 8)}`;
          const contactHtml = $(element).clone().wrap('<div>').parent().html();
          
          // Extract relevant CSS for this contact form
          const extractedCss = this.extractRelevantCss(cssString, selector);
          
          const contactComponent = {
            id: componentId,
            type: 'contact',
            name: `${templateInfo.name} Contact Form`,
            html: contactHtml,
            css: extractedCss,
            sourceFile: path.basename(file),
            templateId: templateInfo.id,
            industry: templateInfo.industry,
            styleType: templateInfo.styleType,
            attributes: {
              hasNameField: contactHtml.includes('name') || contactHtml.includes('Name'),
              hasEmailField: contactHtml.includes('email') || contactHtml.includes('Email'),
              hasPhoneField: contactHtml.includes('phone') || contactHtml.includes('Phone'),
              hasMessageField: contactHtml.includes('message') || contactHtml.includes('Message') || $(element).find('textarea').length > 0,
              hasMap: contactHtml.includes('map') || contactHtml.includes('Map') || contactHtml.includes('iframe'),
              hasCaptcha: contactHtml.includes('captcha') || contactHtml.includes('recaptcha')
            }
          };
          
          components.push(contactComponent);
        });
      }
    }
    
    // Also check for contact forms in pages named 'contact'
    if (path.basename(file).toLowerCase().includes('contact') &&
        components.filter(c => c.type === 'contact').length === 0) {
      
      $('form').each((i, element) => {
        const componentId = `contact-${uuidv4().substring(0, 8)}`;
        const contactHtml = $(element).clone().wrap('<div>').parent().html();
        
        // Extract relevant CSS
        const selector = element.tagName.toLowerCase() + 
                        (element.id ? `#${element.id}` : '') +
                        (element.className ? `.${element.className.replace(/\s+/g, '.')}` : '');
        
        const extractedCss = this.extractRelevantCss(cssString, selector);
        
        const contactComponent = {
          id: componentId,
          type: 'contact',
          name: `${templateInfo.name} Contact Form`,
          html: contactHtml,
          css: extractedCss,
          sourceFile: path.basename(file),
          templateId: templateInfo.id,
          industry: templateInfo.industry,
          styleType: templateInfo.styleType,
          attributes: {
            inContactPage: true,
            hasNameField: contactHtml.includes('name') || contactHtml.includes('Name'),
            hasEmailField: contactHtml.includes('email') || contactHtml.includes('Email'),
            hasPhoneField: contactHtml.includes('phone') || contactHtml.includes('Phone'),
            hasMessageField: contactHtml.includes('message') || contactHtml.includes('Message') || $(element).find('textarea').length > 0
          }
        };
        
        components.push(contactComponent);
      });
      
      // If still no contact form found, look for sections containing contact information
      if (components.filter(c => c.type === 'contact').length === 0) {
        $('section, .section, .container').each((i, element) => {
          if ($(element).text().toLowerCase().includes('contact') || 
              $(element).text().toLowerCase().includes('get in touch')) {
            
            const componentId = `contact-info-${uuidv4().substring(0, 8)}`;
            const contactHtml = $(element).clone().wrap('<div>').parent().html();
            
            // Extract relevant CSS
            const selector = element.tagName.toLowerCase() + 
                            (element.id ? `#${element.id}` : '') +
                            (element.className ? `.${element.className.replace(/\s+/g, '.')}` : '');
            
            const extractedCss = this.extractRelevantCss(cssString, selector);
            
            const contactComponent = {
              id: componentId,
              type: 'contact',
              name: `${templateInfo.name} Contact Information`,
              html: contactHtml,
              css: extractedCss,
              sourceFile: path.basename(file),
              templateId: templateInfo.id,
              industry: templateInfo.industry,
              styleType: templateInfo.styleType,
              attributes: {
                isContactInfo: true,
                hasAddress: contactHtml.includes('address') || contactHtml.includes('Address'),
                hasPhone: contactHtml.includes('phone') || contactHtml.includes('Phone'),
                hasEmail: contactHtml.includes('email') || contactHtml.includes('Email'),
                hasMap: contactHtml.includes('map') || contactHtml.includes('Map') || contactHtml.includes('iframe')
              }
            };
            
            components.push(contactComponent);
          }
        });
      }
    }
  }

  extractCardSections($, file, cssString, templateInfo, components) {
    // Common selectors for card sections (products, team members, etc.)
    const cardSelectors = [
      '.cards',
      '.card-section',
      '.products',
      '.product-grid',
      '.team',
      '.team-section',
      '.portfolio',
      '.portfolio-section',
      '.blog',
      '.blog-section',
      '.posts',
      '.projects'
    ];
    
    for (const selector of cardSelectors) {
      const cardElements = $(selector);
      if (cardElements.length > 0) {
        cardElements.each((i, element) => {
          // Determine the type of card section
          let cardType = 'cards';
          
          if (selector.includes('product') || $(element).text().toLowerCase().includes('product')) {
            cardType = 'products';
          } else if (selector.includes('team') || $(element).text().toLowerCase().includes('team') || 
                     $(element).text().toLowerCase().includes('member') || 
                     $(element).text().toLowerCase().includes('staff')) {
            cardType = 'team';
          } else if (selector.includes('blog') || selector.includes('post') || 
                     $(element).text().toLowerCase().includes('blog') || 
                     $(element).text().toLowerCase().includes('post') || 
                     $(element).text().toLowerCase().includes('news')) {
            cardType = 'blog';
          } else if (selector.includes('portfolio') || selector.includes('project') || 
                     $(element).text().toLowerCase().includes('portfolio') || 
                     $(element).text().toLowerCase().includes('project') || 
                     $(element).text().toLowerCase().includes('work')) {
            cardType = 'portfolio';
          }
          
          const componentId = `${cardType}-${uuidv4().substring(0, 8)}`;
          const cardHtml = $(element).clone().wrap('<div>').parent().html();
          
          // Extract relevant CSS for this card section
          const extractedCss = this.extractRelevantCss(cssString, selector);
          
          const cardComponent = {
            id: componentId,
            type: cardType,
            name: `${templateInfo.name} ${this.capitalize(cardType)} Section`,
            html: cardHtml,
            css: extractedCss,
            sourceFile: path.basename(file),
            templateId: templateInfo.id,
            industry: templateInfo.industry,
            styleType: templateInfo.styleType,
            attributes: {
              cardCount: $(element).find('.card, [class*="card"], [class*="box"], .col, .column').length,
              hasImages: $(element).find('img').length > 0,
              hasButtons: $(element).find('button, .btn, a.button').length > 0,
              hasPricing: cardHtml.includes('price') || cardHtml.includes('$') || cardHtml.includes('€') || cardHtml.includes('£'),
              hasFilters: cardHtml.includes('filter') || $(element).find('.filter, [class*="filter"]').length > 0
            }
          };
          
          components.push(cardComponent);
        });
      }
    }
    
    // Look for specific industry-related card sections based on the template's industry
    if (templateInfo.industry === 'realestate') {
      $('section, .section, div.container').each((i, element) => {
        const text = $(element).text().toLowerCase();
        if (text.includes('property') || text.includes('properties') || text.includes('listing') || 
            text.includes('house') || text.includes('apartment') || text.includes('villa')) {
          
          // Look for cards or grid items that might be property listings
          const cards = $(element).find('.card, [class*="card"], [class*="property"], [class*="listing"], .col, .column');
          
          if (cards.length >= 2) {
            const componentId = `property-${uuidv4().substring(0, 8)}`;
            const propertyHtml = $(element).clone().wrap('<div>').parent().html();
            
            // Extract relevant CSS
            const selector = element.tagName.toLowerCase() + 
                            (element.id ? `#${element.id}` : '') +
                            (element.className ? `.${element.className.replace(/\s+/g, '.')}` : '');
            
            const extractedCss = this.extractRelevantCss(cssString, selector);
            
            const propertyComponent = {
              id: componentId,
              type: 'property-listing',
              name: `${templateInfo.name} Property Listings`,
              html: propertyHtml,
              css: extractedCss,
              sourceFile: path.basename(file),
              templateId: templateInfo.id,
              industry: templateInfo.industry,
              styleType: templateInfo.styleType,
              attributes: {
                listingCount: cards.length,
                hasImages: $(element).find('img').length > 0,
                hasPricing: propertyHtml.includes('price') || propertyHtml.includes('$') || propertyHtml.includes('€') || propertyHtml.includes('£'),
                hasAmenities: propertyHtml.includes('bedroom') || propertyHtml.includes('bathroom') || propertyHtml.includes('sqft') || propertyHtml.includes('sq ft')
              }
            };
            
            components.push(propertyComponent);
          }
        }
      });
    }
  }

  extractIndustrySpecificComponents($, file, cssString, templateInfo, components) {
    // Handle specific components based on template industry
    switch (templateInfo.industry) {
      case 'realestate':
        this.extractRealEstateComponents($, file, cssString, templateInfo, components);
        break;
      case 'restaurant':
        this.extractRestaurantComponents($, file, cssString, templateInfo, components);
        break;
      case 'ecommerce':
        this.extractEcommerceComponents($, file, cssString, templateInfo, components);
        break;
      case 'education':
        this.extractEducationComponents($, file, cssString, templateInfo, components);
        break;
      default:
        // No specific extractors for this industry
        break;
    }
  }

  extractRealEstateComponents($, file, cssString, templateInfo, components) {
    // Extract property details component
    if (path.basename(file).toLowerCase().includes('property') || 
        path.basename(file).toLowerCase().includes('detail')) {
      
      // Look for property detail sections
      $('section, .section, div.container:has(h1, h2)').each((i, element) => {
        const text = $(element).text().toLowerCase();
        if (text.includes('property') || text.includes('detail') || 
            text.includes('house') || text.includes('apartment') || 
            text.includes('villa') || text.includes('listing')) {
          
          const componentId = `property-detail-${uuidv4().substring(0, 8)}`;
          const detailHtml = $(element).clone().wrap('<div>').parent().html();
          
          // Extract relevant CSS
          const selector = element.tagName.toLowerCase() + 
                          (element.id ? `#${element.id}` : '') +
                          (element.className ? `.${element.className.replace(/\s+/g, '.')}` : '');
          
          const extractedCss = this.extractRelevantCss(cssString, selector);
          
          const detailComponent = {
            id: componentId,
            type: 'property-detail',
            name: `${templateInfo.name} Property Detail`,
            html: detailHtml,
            css: extractedCss,
            sourceFile: path.basename(file),
            templateId: templateInfo.id,
            industry: templateInfo.industry,
            styleType: templateInfo.styleType,
            attributes: {
              hasGallery: $(element).find('.gallery, [class*="gallery"], [class*="slider"], [class*="carousel"]').length > 0,
              hasAmenities: detailHtml.includes('amenities') || detailHtml.includes('features') || detailHtml.includes('bedroom') || detailHtml.includes('bathroom'),
              hasMap: detailHtml.includes('map') || detailHtml.includes('location') || detailHtml.includes('iframe'),
              hasContactAgent: detailHtml.includes('agent') || detailHtml.includes('contact') || detailHtml.includes('inquiry')
            }
          };
          
          components.push(detailComponent);
        }
      });
    }
    
    // Extract property search form
    $('.search-form, [class*="search-form"], form:has(select[name*="property"], select[name*="location"])').each((i, element) => {
      const componentId = `property-search-${uuidv4().substring(0, 8)}`;
      const searchHtml = $(element).clone().wrap('<div>').parent().html();
      
      // Extract relevant CSS
      const selector = element.tagName.toLowerCase() + 
                      (element.id ? `#${element.id}` : '') +
                      (element.className ? `.${element.className.replace(/\s+/g, '.')}` : '');
      
      const extractedCss = this.extractRelevantCss(cssString, selector);
      
      const searchComponent = {
        id: componentId,
        type: 'property-search',
        name: `${templateInfo.name} Property Search`,
        html: searchHtml,
        css: extractedCss,
        sourceFile: path.basename(file),
        templateId: templateInfo.id,
        industry: templateInfo.industry,
        styleType: templateInfo.styleType,
        attributes: {
          hasLocationField: searchHtml.includes('location') || searchHtml.includes('city') || searchHtml.includes('zip'),
          hasPriceRange: searchHtml.includes('price') || searchHtml.includes('budget'),
          hasPropertyType: searchHtml.includes('type') || searchHtml.includes('category'),
          hasBedroomsBathrooms: searchHtml.includes('bedroom') || searchHtml.includes('bathroom')
        }
      };
      
      components.push(searchComponent);
    });
  }

  extractRestaurantComponents($, file, cssString, templateInfo, components) {
    // Extract menu sections
    $('.menu, .menu-section, .food-menu, [class*="menu"]').each((i, element) => {
      const text = $(element).text().toLowerCase();
      if (text.includes('menu') || text.includes('dish') || text.includes('food') || 
          text.includes('drink') || text.includes('special') || text.includes('cuisine')) {
        
        const componentId = `menu-${uuidv4().substring(0, 8)}`;
        const menuHtml = $(element).clone().wrap('<div>').parent().html();
        
        // Extract relevant CSS
        const selector = element.tagName.toLowerCase() + 
                        (element.id ? `#${element.id}` : '') +
                        (element.className ? `.${element.className.replace(/\s+/g, '.')}` : '');
        
        const extractedCss = this.extractRelevantCss(cssString, selector);
        
        const menuComponent = {
          id: componentId,
          type: 'restaurant-menu',
          name: `${templateInfo.name} Restaurant Menu`,
          html: menuHtml,
          css: extractedCss,
          sourceFile: path.basename(file),
          templateId: templateInfo.id,
          industry: templateInfo.industry,
          styleType: templateInfo.styleType,
          attributes: {
            hasCategoryTabs: $(element).find('.tabs, .nav-tabs, [role="tablist"]').length > 0,
            hasPricing: menuHtml.includes('price') || menuHtml.includes('$') || menuHtml.includes('€') || menuHtml.includes('£'),
            hasDishImages: $(element).find('img').length > 0,
            hasDishDescriptions: $(element).find('p').length > $(element).find('.menu-item, [class*="menu-item"]').length // Approximate check for descriptions
          }
        };
        
        components.push(menuComponent);
      }
    });
    
    // Extract reservation form
    $('.reservation, .reservation-form, .booking, .booking-form, form:has(input[name*="reservation"], input[name*="booking"])').each((i, element) => {
      const componentId = `reservation-${uuidv4().substring(0, 8)}`;
      const reservationHtml = $(element).clone().wrap('<div>').parent().html();
      
      // Extract relevant CSS
      const selector = element.tagName.toLowerCase() + 
                      (element.id ? `#${element.id}` : '') +
                      (element.className ? `.${element.className.replace(/\s+/g, '.')}` : '');
      
      const extractedCss = this.extractRelevantCss(cssString, selector);
      
      const reservationComponent = {
        id: componentId,
        type: 'restaurant-reservation',
        name: `${templateInfo.name} Reservation Form`,
        html: reservationHtml,
        css: extractedCss,
        sourceFile: path.basename(file),
        templateId: templateInfo.id,
        industry: templateInfo.industry,
        styleType: templateInfo.styleType,
        attributes: {
          hasDatePicker: reservationHtml.includes('date') || $(element).find('input[type="date"]').length > 0,
          hasTimePicker: reservationHtml.includes('time') || $(element).find('input[type="time"]').length > 0,
          hasGuestCount: reservationHtml.includes('guest') || reservationHtml.includes('people') || reservationHtml.includes('party')
        }
      };
      
      components.push(reservationComponent);
    });
  }

  extractEcommerceComponents($, file, cssString, templateInfo, components) {
    // Extract product detail component
    if (path.basename(file).toLowerCase().includes('product') || 
        path.basename(file).toLowerCase().includes('detail')) {
      
      $('section, .section, div.container:has(h1, h2)').each((i, element) => {
        const text = $(element).text().toLowerCase();
        if (text.includes('product') || text.includes('item') || 
            text.includes('detail') || text.includes('description')) {
          
          const componentId = `product-detail-${uuidv4().substring(0, 8)}`;
          const productHtml = $(element).clone().wrap('<div>').parent().html();
          
          // Extract relevant CSS
          const selector = element.tagName.toLowerCase() + 
                          (element.id ? `#${element.id}` : '') +
                          (element.className ? `.${element.className.replace(/\s+/g, '.')}` : '');
          
          const extractedCss = this.extractRelevantCss(cssString, selector);
          
          const productComponent = {
            id: componentId,
            type: 'product-detail',
            name: `${templateInfo.name} Product Detail`,
            html: productHtml,
            css: extractedCss,
            sourceFile: path.basename(file),
            templateId: templateInfo.id,
            industry: templateInfo.industry,
            styleType: templateInfo.styleType,
            attributes: {
              hasGallery: $(element).find('.gallery, [class*="gallery"], [class*="slider"], [class*="carousel"]').length > 0,
              hasPrice: productHtml.includes('price') || productHtml.includes('$') || productHtml.includes('€') || productHtml.includes('£'),
              hasVariants: productHtml.includes('option') || productHtml.includes('variant') || productHtml.includes('size') || productHtml.includes('color'),
              hasAddToCart: productHtml.includes('cart') || productHtml.includes('add to') || productHtml.includes('buy')
            }
          };
          
          components.push(productComponent);
        }
      });
    }
    
    // Extract shopping cart component
    $('.cart, .shopping-cart, #cart, [class*="cart"]').each((i, element) => {
      const text = $(element).text().toLowerCase();
      if (text.includes('cart') || text.includes('basket') || text.includes('checkout')) {
        
        const componentId = `cart-${uuidv4().substring(0, 8)}`;
        const cartHtml = $(element).clone().wrap('<div>').parent().html();
        
        // Extract relevant CSS
        const selector = element.tagName.toLowerCase() + 
                        (element.id ? `#${element.id}` : '') +
                        (element.className ? `.${element.className.replace(/\s+/g, '.')}` : '');
        
        const extractedCss = this.extractRelevantCss(cssString, selector);
        
        const cartComponent = {
          id: componentId,
          type: 'shopping-cart',
          name: `${templateInfo.name} Shopping Cart`,
          html: cartHtml,
          css: extractedCss,
          sourceFile: path.basename(file),
          templateId: templateInfo.id,
          industry: templateInfo.industry,
          styleType: templateInfo.styleType,
          attributes: {
            hasProductImages: $(element).find('img').length > 0,
            hasQuantityControls: cartHtml.includes('quantity') || $(element).find('input[type="number"]').length > 0,
            hasSubtotal: cartHtml.includes('subtotal') || cartHtml.includes('total'),
            hasCheckoutButton: cartHtml.includes('checkout') || cartHtml.includes('proceed to')
          }
        };
        
        components.push(cartComponent);
      }
    });
  }

  extractEducationComponents($, file, cssString, templateInfo, components) {
    // Extract course listings
    $('.courses, .course-list, .classes, [class*="course"]').each((i, element) => {
      const text = $(element).text().toLowerCase();
      if (text.includes('course') || text.includes('class') || 
          text.includes('learn') || text.includes('education')) {
        
        const componentId = `course-${uuidv4().substring(0, 8)}`;
        const courseHtml = $(element).clone().wrap('<div>').parent().html();
        
        // Extract relevant CSS
        const selector = element.tagName.toLowerCase() + 
                        (element.id ? `#${element.id}` : '') +
                        (element.className ? `.${element.className.replace(/\s+/g, '.')}` : '');
        
        const extractedCss = this.extractRelevantCss(cssString, selector);
        
        const courseComponent = {
          id: componentId,
          type: 'course-listing',
          name: `${templateInfo.name} Course Listings`,
          html: courseHtml,
          css: extractedCss,
          sourceFile: path.basename(file),
          templateId: templateInfo.id,
          industry: templateInfo.industry,
          styleType: templateInfo.styleType,
          attributes: {
            courseCount: $(element).find('.course, [class*="course"], .card, [class*="card"]').length,
            hasInstructors: courseHtml.includes('instructor') || courseHtml.includes('teacher') || courseHtml.includes('professor'),
            hasDates: courseHtml.includes('date') || courseHtml.includes('schedule') || courseHtml.includes('start'),
            hasPricing: courseHtml.includes('price') || courseHtml.includes('$') || courseHtml.includes('€') || courseHtml.includes('£'),
            hasEnrollButton: courseHtml.includes('enroll') || courseHtml.includes('register') || courseHtml.includes('sign up')
          }
        };
        
        components.push(courseComponent);
      }
    });
  }

  extractRelevantCss(cssString, selector) {
    try {
      // Basic implementation - extract CSS rules containing the selector
      const cssRules = cssString.split('}');
      let relevantCss = '';
      
      // Remove the dot from class selectors for better matching
      const cleanSelector = selector.replace(/\./g, '');
      
      for (const rule of cssRules) {
        if (rule.includes(selector) || rule.includes(cleanSelector)) {
          relevantCss += rule + '}';
        }
      }
      
      // Look for nested selectors as well (for elements inside the target selector)
      for (const rule of cssRules) {
        if (rule.includes(`${selector} `) || rule.includes(`${cleanSelector} `)) {
          relevantCss += rule + '}';
        }
      }
      
      // Add media queries that apply to this selector
      const mediaQueryRegex = /@media[^{]+{([^{}]|{[^{}]*})*}/g;
      const mediaQueries = cssString.match(mediaQueryRegex);
      
      if (mediaQueries) {
        for (const mediaQuery of mediaQueries) {
          if (mediaQuery.includes(selector) || mediaQuery.includes(cleanSelector)) {
            relevantCss += mediaQuery;
          }
        }
      }
      
      return relevantCss;
    } catch (error) {
      console.warn(`Error extracting CSS for selector ${selector}:`, error);
      return '';
    }
  }

  estimateColumnCount(element) {
    // Try to determine column count from grid layout
    const columns = element.find('.col, .col-md, .col-lg, [class*="col-"], .column').length;
    if (columns > 0) {
      return Math.min(columns, 12); // Cap at 12 (Bootstrap's column system)
    }
    
    // Try to find other clues like card count
    const cards = element.find('.card, [class*="card"], [class*="box"]').length;
    if (cards > 0) {
      return Math.min(cards, 6); // Cap at a reasonable number
    }
    
    return 3; // Default assumption for a feature section
  }

  countTestimonials(element) {
    // Look for testimonial items, quotes, etc.
    const testimonialItems = element.find('.testimonial, [class*="testimonial-item"], .review, [class*="review-item"], blockquote, .quote').length;
    
    if (testimonialItems > 0) {
      return testimonialItems;
    }
    
    // Count cards or columns that might contain testimonials
    const cards = element.find('.card, [class*="card"], .col, .column').length;
    if (cards > 0) {
      return cards;
    }
    
    return 3; // Default assumption
  }

  calculateTextSimilarity(text1, text2) {
    // Simple Jaccard similarity for text comparison
    const words1 = new Set(text1.toLowerCase().split(/\W+/).filter(w => w.length > 2));
    const words2 = new Set(text2.toLowerCase().split(/\W+/).filter(w => w.length > 2));
    
    const intersection = new Set([...words1].filter(word => words2.has(word)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  async generateEmbeddings(components) {
    const componentsWithEmbeddings = [];
    
    // Process in batches to avoid memory issues
    const batchSize = 10;
    for (let i = 0; i < components.length; i += batchSize) {
      const batch = components.slice(i, i + batchSize);
      const batchWithEmbeddings = await this.processBatch(batch);
      componentsWithEmbeddings.push(...batchWithEmbeddings);
      
      // Report progress
      this.emit('progress', {
        status: 'embedding_generation',
        message: `Generated embeddings for ${i + batchWithEmbeddings.length} of ${components.length} components`,
        progress: 70 + Math.round((i + batchWithEmbeddings.length) / components.length * 20)
      });
    }
    
    return componentsWithEmbeddings;
  }

  async processBatch(componentBatch) {
    const result = [];
    
    for (const component of componentBatch) {
      try {
        // Create text representation of the component for embedding
        const textForEmbedding = `
          Component Type: ${component.type}
          Name: ${component.name}
          Industry: ${component.industry}
          Style: ${component.styleType}
          Attributes: ${JSON.stringify(component.attributes)}
          HTML Content Summary: ${this.summarizeHtml(component.html)}
        `;
        
        // Generate embedding using Ollama
        const embedding = await this.generateOllamaEmbedding(textForEmbedding);
        
        // Add embedding to component
        result.push({
          ...component,
          embedding
        });
      } catch (error) {
        console.error(`Error generating embedding for component ${component.id}:`, error);
        // Add component without embedding so we don't lose it
        result.push(component);
      }
    }
    
    return result;
  }

  summarizeHtml(html) {
    // Get a text-only summary of the HTML content for better embedding
    try {
      const $ = cheerio.load(html);
      
      // Extract headings
      const headings = [];
      $('h1, h2, h3, h4, h5, h6').each((i, element) => {
        headings.push($(element).text().trim());
      });
      
      // Extract paragraph text
      const paragraphs = [];
      $('p').each((i, element) => {
        paragraphs.push($(element).text().trim());
      });
      
      // Extract button/link text
      const buttons = [];
      $('button, a.btn, .button, a[class*="btn"]').each((i, element) => {
        buttons.push($(element).text().trim());
      });
      
      // Combine and truncate
      let summary = '';
      
      if (headings.length > 0) {
        summary += 'Headings: ' + headings.join(', ') + '. ';
      }
      
      if (paragraphs.length > 0) {
        const combinedParagraphs = paragraphs.join(' ').substring(0, 500);
        summary += 'Text: ' + combinedParagraphs + '. ';
      }
      
      if (buttons.length > 0) {
        summary += 'Buttons: ' + buttons.join(', ') + '. ';
      }
      
      return summary;
    } catch (error) {
      console.warn('Error summarizing HTML:', error);
      return '';
    }
  }

  async storeComponentsInDatabase(components) {
    let client = null;
    
    try {
      client = new MongoClient(this.mongoUri);
      await client.connect();
      
      const db = client.db(this.dbName);
      const collection = db.collection('components');
      
      // Store in batches to avoid memory issues
      const batchSize = 50;
      for (let i = 0; i < components.length; i += batchSize) {
        const batch = components.slice(i, i + batchSize);
        
        // Prepare documents for insertion
        const documents = batch.map(component => ({
          _id: component.id,
          type: component.type,
          name: component.name,
          html: component.html,
          css: component.css,
          sourceFile: component.sourceFile,
          templateId: component.templateId,
          industry: component.industry,
          styleType: component.styleType,
          attributes: component.attributes,
          embedding: component.embedding,
          createdAt: new Date()
        }));
        
        // Insert into MongoDB
        await collection.insertMany(documents, { ordered: false });
        
        // Report progress
        this.emit('progress', {
          status: 'database_storage',
          message: `Stored ${i + batch.length} of ${components.length} components in database`,
          progress: 90 + Math.round((i + batch.length) / components.length * 10)
        });
      }
      
      // Store template metadata
      if (components.length > 0) {
        const templateCollection = db.collection('templates');
        const templateId = components[0].templateId;
        const templateInfo = {
          _id: templateId,
          name: components[0].name.replace(' Header', '').replace(' Footer', '').replace(' Section', ''),
          industry: components[0].industry,
          styleType: components[0].styleType,
          componentCount: components.length,
          componentTypes: [...new Set(components.map(c => c.type))],
          createdAt: new Date()
        };
        
        await templateCollection.updateOne(
          { _id: templateId },
          { $set: templateInfo },
          { upsert: true }
        );
      }
    } catch (error) {
      console.error('Error storing components in database:', error);
      throw error;
    } finally {
      if (client) {
        await client.close();
      }
    }
  }
}

module.exports = AdaptiveTemplateProcessor;