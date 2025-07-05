const { google } = require('googleapis');
const axios = require('axios');
const http = require('http');

class YouTubeChatBot {
    constructor() {
        // Load configuration from environment variables
        this.config = {
            apiKey: process.env.YOUTUBE_API_KEY,
            clientId: process.env.YOUTUBE_CLIENT_ID,
            clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
            channelId: process.env.YOUTUBE_CHANNEL_ID,
            botName: process.env.BOT_NAME || 'GameBuddy',
            ownerUsername: process.env.OWNER_USERNAME || '',
            redirectUri: "urn:ietf:wg:oauth:2.0:oob"
        };

        // Smarter bot responses with context
        this.responses = {
            greetings: [
                "Hey there! Welcome to the stream! 🎮",
                "What's up! Great to see you here! 🔥",
                "Welcome to the party! 🚀",
                "Hey! Thanks for stopping by! 😊"
            ],
            reactions: {
                amazing: ["That was incredible! 🔥", "AMAZING play!", "No way! How?! 🤯"],
                fail: ["Ouch! 😅", "We've all been there!", "Next time! 💪"],
                clutch: ["CLUTCH! 🔥", "That was close!", "Heart attack moment! 😱"],
                funny: ["LMAO 😂", "That's hilarious!", "LOL! 🤣"]
            },
            encouragement: ["You got this! 💪", "Keep going!", "Don't give up! ⭐"]
        };

        this.youtube = google.youtube('v3');
        this.oauth2Client = null;
        this.liveChatId = null;
        this.nextPageToken = null;
        this.isRunning = false;
        this.videoId = null;
        this.streamCheckInterval = null;
        this.lastResponseTime = 0;
        
        // Smart features
        this.chatHistory = new Map(); // Track users
        this.responseCount = 0; // Track bot activity
        this.maxResponsesPerHour = 20; // Limit responses
        this.hourlyReset = Date.now();
        
        this.setupOAuth();
        this.setupWebServer();
    }

    setupWebServer() {
        const PORT = process.env.PORT || 3000;
        
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
                status: 'running',
                botName: this.config.botName,
                isMonitoring: this.isRunning,
                currentStream: this.videoId || 'none',
                uptime: process.uptime(),
                responsesThisHour: this.responseCount,
                timestamp: new Date().toISOString()
            }, null, 2));
        });

        server.listen(PORT, () => {
            console.log(`🌐 Bot status server running on port ${PORT}`);
        });

        this.setupKeepAlive();
    }

    setupKeepAlive() {
        setInterval(() => {
            const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_URL;
            if (domain) {
                axios.get(`https://${domain}`)
                    .then(() => console.log('🏓 Keep-alive ping'))
                    .catch(() => {});
            }
        }, 25 * 60 * 1000);
    }

    setupOAuth() {
        this.oauth2Client = new google.auth.OAuth2(
            this.config.clientId,
            this.config.clientSecret,
            this.config.redirectUri
        );
        
        if (process.env.OAUTH_TOKENS) {
            try {
                const tokens = JSON.parse(process.env.OAUTH_TOKENS);
                this.oauth2Client.setCredentials(tokens);
                console.log('✅ OAuth tokens loaded from environment');
            } catch (error) {
                console.error('❌ Failed to parse OAuth tokens:', error.message);
            }
        } else {
            console.warn('⚠️ No OAuth tokens found. Bot will only read chat, not send messages.');
        }
        
        google.options({ auth: this.oauth2Client });
    }

    // Reset hourly response counter
    resetHourlyCounter() {
        const now = Date.now();
        if (now - this.hourlyReset > 3600000) { // 1 hour
            this.responseCount = 0;
            this.hourlyReset = now;
            console.log('🔄 Hourly response counter reset');
        }
    }

    // Check if currently streaming (with better filtering)
    async checkIfStreaming() {
        try {
            const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
                params: {
                    part: 'snippet',
                    channelId: this.config.channelId,
                    eventType: 'live',
                    type: 'video',
                    key: this.config.apiKey,
                    maxResults: 1,
                    order: 'date' // Get most recent live stream
                }
            });

            if (response.data.items && response.data.items.length > 0) {
                const newVideoId = response.data.items[0].id.videoId;
                
                if (newVideoId !== this.videoId) {
                    this.videoId = newVideoId;
                    const title = response.data.items[0].snippet.title;
                    console.log(`🎥 New live stream detected!`);
                    console.log(`📺 Video ID: ${this.videoId}`);
                    console.log(`🎬 Title: ${title}`);
                    
                    // Reset response counters for new stream
                    this.responseCount = 0;
                    this.chatHistory.clear();
                    
                    return true;
                }
                return this.videoId !== null;
            } else {
                if (this.videoId) {
                    console.log('📺 Stream ended');
                    this.cleanup();
                }
                return false;
            }
        } catch (error) {
            console.error('Error checking stream status:', error.message);
            return false;
        }
    }

    async getLiveChatId() {
        try {
            const response = await this.youtube.videos.list({
                part: ['liveStreamingDetails'],
                id: [this.videoId],
                key: this.config.apiKey
            });

            if (response.data.items && response.data.items.length > 0) {
                const liveChatId = response.data.items[0].liveStreamingDetails?.activeLiveChatId;
                if (liveChatId) {
                    this.liveChatId = liveChatId;
                    console.log('✅ Live chat connected!');
                    return true;
                } else {
                    console.log('⚠️ Live chat not available for this stream');
                    return false;
                }
            }
            return false;
        } catch (error) {
            console.error('Error getting live chat ID:', error.message);
            return false;
        }
    }

    cleanup() {
        this.videoId = null;
        this.liveChatId = null;
        this.nextPageToken = null;
        this.isRunning = false;
        this.responseCount = 0;
        this.chatHistory.clear();
    }

    async startContinuousMonitoring() {
        console.log('🤖 YouTube Chat Bot - Smart Edition');
        console.log('===================================');
        console.log(`🔧 Bot Name: ${this.config.botName}`);
        console.log(`📺 Channel ID: ${this.config.channelId}`);
        console.log(`⚙️ Max responses/hour: ${this.maxResponsesPerHour}`);
        console.log('🔍 Monitoring for live streams...\n');
        
        // Check for streams every 2 minutes
        this.streamCheckInterval = setInterval(async () => {
            this.resetHourlyCounter();
            const isStreaming = await this.checkIfStreaming();
            
            if (isStreaming && !this.isRunning) {
                console.log('🚀 Connecting to live chat...');
                const chatReady = await this.getLiveChatId();
                if (chatReady) {
                    this.isRunning = true;
                    this.pollMessages();
                    console.log('🎮 Bot is now active in chat!\n');
                }
            }
        }, 2 * 60 * 1000);

        // Initial check
        const isStreaming = await this.checkIfStreaming();
        if (isStreaming) {
            const chatReady = await this.getLiveChatId();
            if (chatReady) {
                this.isRunning = true;
                this.pollMessages();
                console.log('🎮 Bot is now active in chat!\n');
            }
        }
    }

    async pollMessages() {
        if (!this.isRunning || !this.liveChatId) return;

        try {
            const response = await this.youtube.liveChatMessages.list({
                liveChatId: this.liveChatId,
                part: ['snippet', 'authorDetails'],
                pageToken: this.nextPageToken
            });

            if (response.data.items) {
                for (const message of response.data.items) {
                    await this.processMessage(message);
                }
            }

            this.nextPageToken = response.data.nextPageToken;
            
            const pollInterval = Math.max(response.data.pollingIntervalMillis || 5000, 2000);
            setTimeout(() => this.pollMessages(), pollInterval);
            
        } catch (error) {
            console.error('Error polling messages:', error.message);
            
            if (error.message.includes('disabled') || error.message.includes('not found')) {
                console.log('📺 Stream ended or chat disabled');
                this.cleanup();
                return;
            }
            
            setTimeout(() => this.pollMessages(), 10000);
        }
    }

    async processMessage(message) {
        const author = message.authorDetails.displayName;
        const text = message.snippet.displayMessage;
        const textLower = text.toLowerCase();
        
        console.log(`💬 ${author}: ${text}`);

        // Don't respond to own messages
        if (author === this.config.botName) return;

        // Track user
        this.trackUser(author, textLower);

        // Reset hourly counter
        this.resetHourlyCounter();

        // Check if we've hit response limit
        if (this.responseCount >= this.maxResponsesPerHour) {
            console.log('⏱️ Response limit reached for this hour');
            return;
        }

        // Smart rate limiting (FIXED!)
        const now = Date.now();
        if (now - this.lastResponseTime < 5000) return; // 5 seconds between responses

        // Generate smart response
        const response = this.generateSmartResponse(textLower, author);
        
        if (response) {
            this.lastResponseTime = now;
            this.responseCount++;
            
            // Human-like delay (2-6 seconds)
            const delay = Math.random() * 4000 + 2000;
            setTimeout(() => this.sendMessage(response), delay);
        }
    }

    trackUser(author, text) {
        if (!this.chatHistory.has(author)) {
            this.chatHistory.set(author, {
                messageCount: 1,
                firstSeen: Date.now(),
                isNew: true
            });
        } else {
            const userData = this.chatHistory.get(author);
            userData.messageCount++;
            userData.isNew = false;
            this.chatHistory.set(author, userData);
        }
    }

    generateSmartResponse(text, author) {
        // Admin commands (FIXED - only for owner!)
        if (author === this.config.ownerUsername) {
            if (text === '!status') {
                return `🤖 Status: Active | Stream: ${this.videoId || 'none'} | Responses: ${this.responseCount}/${this.maxResponsesPerHour}`;
            }
            if (text === '!ping') {
                return '🏓 Pong!';
            }
            if (text.startsWith('!say ')) {
                return text.substring(5);
            }
            if (text === '!quiet') {
                this.maxResponsesPerHour = 5;
                return '🤖 Set to quiet mode (5 responses/hour)';
            }
            if (text === '!active') {
                this.maxResponsesPerHour = 30;
                return '🤖 Set to active mode (30 responses/hour)';
            }
            if (text === '!normal') {
                this.maxResponsesPerHour = 20;
                return '🤖 Set to normal mode (20 responses/hour)';
            }
        }

        const userData = this.chatHistory.get(author);

        // Welcome new chatters with greetings
        if (this.containsGreeting(text) && userData.isNew) {
            return this.getRandomResponse(this.responses.greetings);
        }

        // Smart keyword responses (more selective)
        if (text.includes('amazing') || text.includes('incredible') || text.includes('insane')) {
            if (Math.random() < 0.3) { // 30% chance
                return this.getRandomResponse(this.responses.reactions.amazing);
            }
        }

        if (text.includes('fail') || text.includes('died') || text.includes('rip')) {
            if (Math.random() < 0.2) { // 20% chance
                return this.getRandomResponse(this.responses.reactions.fail);
            }
        }

        if (text.includes('clutch') || text.includes('close call')) {
            if (Math.random() < 0.4) { // 40% chance for exciting moments
                return this.getRandomResponse(this.responses.reactions.clutch);
            }
        }

        if (text.includes('funny') || text.includes('lol') || text.includes('haha')) {
            if (Math.random() < 0.25) { // 25% chance
                return this.getRandomResponse(this.responses.reactions.funny);
            }
        }

        // Questions get higher priority
        if (text.includes('how are you')) {
            return "I'm doing great! Thanks for asking! How are you enjoying the stream? 😊";
        }

        if (text.includes('what game')) {
            return "This game looks amazing! I love watching these streams! 🎮";
        }

        // Bot questions
        if (text.includes('bot') && (text.includes('are you') || text.includes('real'))) {
            return "Yep, I'm a bot! 🤖 But I'm here to hang out and enjoy the stream with everyone!";
        }

        // MUCH lower random engagement (FIXED!)
        if (Math.random() < 0.05) { // Only 5% chance, not 40%!
            const randomEngagements = [
                "This stream is awesome! 🔥",
                "Great community here! ❤️",
                "Loving the gameplay! 🎮"
            ];
            return this.getRandomResponse(randomEngagements);
        }

        return null; // No response (most of the time)
    }

    containsGreeting(text) {
        const greetings = ['hello', 'hi', 'hey', 'sup', 'what\'s up', 'good morning', 'good evening'];
        return greetings.some(greeting => text.includes(greeting));
    }

    getRandomResponse(responses) {
        return responses[Math.floor(Math.random() * responses.length)];
    }

    async sendMessage(message) {
        if (!process.env.OAUTH_TOKENS) {
            console.log(`🤐 Would send: ${message} (but no OAuth tokens configured)`);
            return;
        }

        try {
            await this.youtube.liveChatMessages.insert({
                part: ['snippet'],
                requestBody: {
                    snippet: {
                        liveChatId: this.liveChatId,
                        type: 'textMessageEvent',
                        textMessageDetails: {
                            messageText: message
                        }
                    }
                }
            });

            console.log(`🤖 ${this.config.botName}: ${message}`);
            
        } catch (error) {
            console.error('Error sending message:', error.message);
        }
    }

    stop() {
        this.isRunning = false;
        if (this.streamCheckInterval) {
            clearInterval(this.streamCheckInterval);
        }
        console.log('⏹️ Bot stopped');
    }
}

// Validate environment variables
function validateEnvironment() {
    const required = [
        'YOUTUBE_API_KEY',
        'YOUTUBE_CLIENT_ID', 
        'YOUTUBE_CLIENT_SECRET',
        'YOUTUBE_CHANNEL_ID'
    ];
    
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
        console.error('❌ Missing required environment variables:');
        missing.forEach(key => console.error(`   - ${key}`));
        console.error('\n💡 Please set these in your hosting platform dashboard.');
        process.exit(1);
    }
    
    console.log('✅ All required environment variables found');
    
    if (!process.env.OAUTH_TOKENS) {
        console.warn('⚠️ OAUTH_TOKENS not set. Bot will only read chat, not send messages.');
        console.warn('💡 Run locally first to get OAuth tokens, then add them to environment.');
    }
}

// Main function
async function main() {
    try {
        validateEnvironment();
        
        const bot = new YouTubeChatBot();
        await bot.startContinuousMonitoring();
        
        console.log('✅ Bot is running in smart mode!');
        console.log('🔄 Will automatically connect when you go live');
        console.log('🧠 Smart response system active\n');
        
    } catch (error) {
        console.error('❌ Bot failed to start:', error.message);
        process.exit(1);
    }
}

process.on('SIGINT', () => {
    console.log('\n👋 Bot shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Bot shutting down gracefully...');
    process.exit(0);
});

main();

module.exports = YouTubeChatBot;