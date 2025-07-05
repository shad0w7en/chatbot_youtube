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
            redirectUri: "urn:ietf:wg:oauth:2.0:oob",
            // Streaming schedule (24-hour format)
            streamingHours: {
                start: parseInt(process.env.STREAM_START_HOUR) || 18, // 6 PM
                end: parseInt(process.env.STREAM_END_HOUR) || 23     // 11 PM
            }
        };

        // Bot personality responses
        this.responses = {
            greetings: [
                "Hey there! Welcome to the stream! 🎮",
                "What's up, gamer! Ready for some epic gameplay?",
                "Welcome to the party! This is gonna be awesome! 🔥",
                "Hey! Great to see you here! Let's have some fun!",
                "Welcome aboard! Hope you enjoy the stream! 🚀"
            ],
            reactions: {
                amazing: [
                    "That was incredible! 🔥",
                    "No way! How did you do that?!",
                    "AMAZING play!",
                    "Absolutely insane! 🤯",
                    "Pro gamer move right there!"
                ],
                fail: [
                    "Ouch! That hurt to watch 😅",
                    "We've all been there!",
                    "Better luck next time!",
                    "F in the chat",
                    "Don't worry, you got this next time!"
                ],
                clutch: [
                    "CLUTCH! 🔥",
                    "That was so close!",
                    "Heart attack moment right there!",
                    "How did you pull that off?!",
                    "Insane clutch play!"
                ],
                funny: [
                    "LMAO 😂",
                    "That's hilarious!",
                    "I can't stop laughing!",
                    "Comedy gold right there!",
                    "LOL that was great!"
                ]
            },
            encouragement: [
                "You got this! 💪",
                "Keep going, you're doing great!",
                "Don't give up!",
                "Believe in yourself!",
                "You're getting better every game!"
            ]
        };

        this.youtube = google.youtube('v3');
        this.oauth2Client = null;
        this.liveChatId = null;
        this.nextPageToken = null;
        this.isRunning = false;
        this.videoId = null;
        this.streamCheckInterval = null;
        this.lastResponseTime = 0;
        this.dailyQuotaUsed = 0;
        this.quotaResetTime = this.getNextQuotaReset();
        
        this.setupOAuth();
        this.setupWebServer();
    }

    // Get next quota reset time (midnight Pacific Time)
    getNextQuotaReset() {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        return tomorrow;
    }

    // Check if we're in streaming hours
    isStreamingTime() {
        const now = new Date();
        const hour = now.getHours();
        const { start, end } = this.config.streamingHours;
        
        if (start <= end) {
            return hour >= start && hour <= end;
        } else {
            // Handle overnight streaming (e.g., 22:00 to 02:00)
            return hour >= start || hour <= end;
        }
    }

    // Check quota before API call
    canMakeApiCall(cost) {
        const now = new Date();
        
        // Reset quota counter if it's a new day
        if (now >= this.quotaResetTime) {
            this.dailyQuotaUsed = 0;
            this.quotaResetTime = this.getNextQuotaReset();
            console.log('🔄 Daily quota reset');
        }
        
        return (this.dailyQuotaUsed + cost) <= 9500; // Keep 500 units buffer
    }

    // Track quota usage
    trackQuotaUsage(cost) {
        this.dailyQuotaUsed += cost;
        console.log(`📊 Quota used: ${this.dailyQuotaUsed}/10000 units`);
        
        if (this.dailyQuotaUsed > 8000) {
            console.warn('⚠️ Approaching quota limit!');
        }
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
                quotaUsed: this.dailyQuotaUsed,
                quotaLimit: 10000,
                quotaResetTime: this.quotaResetTime.toISOString(),
                streamingHours: this.config.streamingHours,
                isStreamingTime: this.isStreamingTime(),
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            }, null, 2));
        });

        server.listen(PORT, () => {
            console.log(`🌐 Bot status server running on port ${PORT}`);
        });

        // Keep service alive (for Railway/Render)
        this.setupKeepAlive();
    }

    setupKeepAlive() {
        setInterval(() => {
            // Ping self to prevent sleeping on free hosting
            const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_URL;
            if (domain) {
                axios.get(`https://${domain}`)
                    .then(() => console.log('🏓 Keep-alive ping'))
                    .catch(() => {}); // Ignore errors
            }
        }, 25 * 60 * 1000); // Every 25 minutes
    }

    setupOAuth() {
        this.oauth2Client = new google.auth.OAuth2(
            this.config.clientId,
            this.config.clientSecret,
            this.config.redirectUri
        );
        
        // Load OAuth tokens from environment
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
        
        // Don't set global auth - we'll specify auth per request
        // google.options({ auth: this.oauth2Client });
    }

    // Check if currently streaming (QUOTA: 100 units)
    async checkIfStreaming() {
        // Don't check if quota is low or outside streaming hours
        if (!this.canMakeApiCall(100)) {
            console.log('⚠️ Skipping stream check - quota limit reached');
            return false;
        }
        
        if (!this.isStreamingTime()) {
            console.log('😴 Outside streaming hours, skipping check');
            return false;
        }

        try {
            // Use direct YouTube API call without OAuth for search
            const response = await this.youtube.search.list({
                part: ['snippet'],
                channelId: this.config.channelId,
                eventType: 'live',
                type: 'video',
                key: this.config.apiKey,
                maxResults: 1,
                auth: null // Explicitly use API key, not OAuth
            });

            this.trackQuotaUsage(100); // Track quota usage

            if (response.data.items && response.data.items.length > 0) {
                const newVideoId = response.data.items[0].id.videoId;
                
                if (newVideoId !== this.videoId) {
                    this.videoId = newVideoId;
                    const title = response.data.items[0].snippet.title;
                    console.log(`🎥 New live stream detected!`);
                    console.log(`📺 Video ID: ${this.videoId}`);
                    console.log(`🎬 Title: ${title}`);
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
            if (error.response) {
                console.error('API Error Details:', error.response.data);
            }
            return false;
        }
    }

    // Get live chat ID from video (QUOTA: 1 unit)
    async getLiveChatId() {
        if (!this.canMakeApiCall(1)) {
            console.log('⚠️ Cannot get live chat ID - quota limit reached');
            return false;
        }

        try {
            const response = await this.youtube.videos.list({
                part: ['liveStreamingDetails'],
                id: [this.videoId],
                key: this.config.apiKey,
                auth: null // Use API key for this call
            });

            this.trackQuotaUsage(1);

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
            if (error.response) {
                console.error('API Error Details:', error.response.data);
            }
            return false;
        }
    }

    // Clean up when stream ends
    cleanup() {
        this.videoId = null;
        this.liveChatId = null;
        this.nextPageToken = null;
        this.isRunning = false;
    }

    // Start continuous monitoring
    async startContinuousMonitoring() {
        console.log('🤖 YouTube Chat Bot - Quota Optimized Edition');
        console.log('=============================================');
        console.log(`🔧 Bot Name: ${this.config.botName}`);
        console.log(`📺 Channel ID: ${this.config.channelId}`);
        console.log(`⏰ Streaming Hours: ${this.config.streamingHours.start}:00 - ${this.config.streamingHours.end}:00`);
        console.log(`📊 Daily Quota Limit: 10,000 units`);
        console.log('🔍 Monitoring for live streams...\n');
        
        // Check for streams every 30 minutes
        this.streamCheckInterval = setInterval(async () => {
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
        }, 30 * 60 * 1000); // Check every 30 minutes

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

    // Poll for new chat messages (QUOTA: 5 units per call)
    async pollMessages() {
        if (!this.isRunning || !this.liveChatId) return;

        // Check quota before polling
        if (!this.canMakeApiCall(5)) {
            console.log('⚠️ Quota exhausted - stopping chat monitoring');
            this.isRunning = false;
            return;
        }

        try {
            const response = await this.youtube.liveChatMessages.list({
                liveChatId: this.liveChatId,
                part: ['snippet', 'authorDetails'],
                pageToken: this.nextPageToken,
                auth: this.oauth2Client // Use OAuth for chat operations
            });

            this.trackQuotaUsage(5);

            if (response.data.items) {
                for (const message of response.data.items) {
                    await this.processMessage(message);
                }
            }

            this.nextPageToken = response.data.nextPageToken;
            
            // Longer wait between polls to save quota
            const pollInterval = Math.max(response.data.pollingIntervalMillis || 10000, 8000);
            setTimeout(() => this.pollMessages(), pollInterval);
            
        } catch (error) {
            console.error('Error polling messages:', error.message);
            
            // If stream ended or chat disabled
            if (error.message.includes('disabled') || error.message.includes('not found')) {
                console.log('📺 Stream ended or chat disabled');
                this.cleanup();
                return;
            }
            
            // Wait and try again
            setTimeout(() => this.pollMessages(), 15000);
        }
    }

    // Process incoming chat message
    async processMessage(message) {
        const author = message.authorDetails.displayName;
        const text = message.snippet.displayMessage;
        const textLower = text.toLowerCase();
        
        console.log(`💬 ${author}: ${text}`);

        // Don't respond to own messages
        if (author === this.config.botName) return;

        // More conservative rate limiting to save quota
        const now = Date.now();
        if (now - this.lastResponseTime < 15000) return; // Wait 15 seconds between responses

        // Generate response
        const response = this.generateResponse(textLower, author);
        
        if (response) {
            this.lastResponseTime = now;
            // Random delay to seem more human (2-8 seconds)
            const delay = Math.random() * 6000 + 2000;
            setTimeout(() => this.sendMessage(response), delay);
        }
    }

    // Generate appropriate response (more selective)
    generateResponse(text, author) {
        // Admin commands for bot owner
        if (author === this.config.ownerUsername) {
            if (text === '!status') {
                return `🤖 Bot Status: Active | Quota: ${this.dailyQuotaUsed}/10000 | Stream: ${this.videoId || 'none'}`;
            }
            if (text === '!quota') {
                return `📊 Quota Used: ${this.dailyQuotaUsed}/10000 units | Resets: ${this.quotaResetTime.toLocaleTimeString()}`;
            }
            if (text === '!ping') {
                return '🏓 Pong!';
            }
            if (text.startsWith('!say ')) {
                return text.substring(5);
            }
        }

        // More selective responses to save quota
        
        // Direct greetings to the bot
        if (text.includes(this.config.botName.toLowerCase()) || text.includes('hello bot') || text.includes('hi bot')) {
            return this.getRandomResponse(this.responses.greetings);
        }

        // Only respond to very specific keywords
        if (text.includes('amazing play') || text.includes('insane play') || text.includes('incredible play')) {
            return this.getRandomResponse(this.responses.reactions.amazing);
        }

        if (text.includes('epic fail') || text.includes('big fail')) {
            return this.getRandomResponse(this.responses.reactions.fail);
        }

        if (text.includes('clutch play') || text.includes('clutch win')) {
            return this.getRandomResponse(this.responses.reactions.clutch);
        }

        // Questions directed at bot
        if (text.includes('bot') && (text.includes('are you') || text.includes('real'))) {
            return "Yep, I'm a bot! 🤖 Here to enjoy the stream with everyone!";
        }

        // Reduce random engagement to 0.5% to save quota
        if (Math.random() < 0.005) {
            const randomEngagements = [
                "This stream is so good! 🔥",
                "Great gameplay! 🎮",
                "Love the energy in chat! ❤️"
            ];
            return this.getRandomResponse(randomEngagements);
        }

        return null; // No response
    }

    // Check if message contains greeting
    containsGreeting(text) {
        const greetings = [
            'hello', 'hi', 'hey', 'sup', 'what\'s up', 'good morning', 
            'good evening', 'good afternoon', 'yo', 'hiya', 'howdy'
        ];
        return greetings.some(greeting => text.includes(greeting));
    }

    // Get random response from array
    getRandomResponse(responses) {
        return responses[Math.floor(Math.random() * responses.length)];
    }

    // Send message to chat (QUOTA: 50 units)
    async sendMessage(message) {
        // Check quota before sending
        if (!this.canMakeApiCall(50)) {
            console.log(`🤐 Would send: ${message} (but quota limit reached)`);
            return;
        }

        // Check if we have OAuth tokens to send messages
        if (!process.env.OAUTH_TOKENS) {
            console.log(`🤐 Would send: ${message} (but no OAuth tokens configured)`);
            return;
        }

        try {
            await this.youtube.liveChatMessages.insert({
                part: ['snippet'],
                auth: this.oauth2Client, // Use OAuth for sending messages
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

            this.trackQuotaUsage(50);
            console.log(`🤖 ${this.config.botName}: ${message}`);
            
        } catch (error) {
            console.error('Error sending message:', error.message);
        }
    }

    // Stop the bot
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
    }
}

// Main function
async function main() {
    try {
        validateEnvironment();
        
        const bot = new YouTubeChatBot();
        await bot.startContinuousMonitoring();
        
        console.log('✅ Bot is running in quota-optimized mode!');
        console.log('🔄 Will check for streams every 30 minutes during streaming hours');
        console.log('📊 Daily quota limit: 10,000 units');
        console.log('🌐 Check bot status at your hosting URL\n');
        
    } catch (error) {
        console.error('❌ Bot failed to start:', error.message);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Bot shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Bot shutting down gracefully...');
    process.exit(0);
});

// Start the bot
main();

module.exports = YouTubeChatBot;