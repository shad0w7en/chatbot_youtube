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
            ownerUsername: process.env.OWNER_USERNAME || '', // Your YouTube username
            redirectUri: "urn:ietf:wg:oauth:2.0:oob"
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
        
        google.options({ auth: this.oauth2Client });
    }

    // Check if currently streaming
    async checkIfStreaming() {
        try {
            const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
                params: {
                    part: 'snippet',
                    channelId: this.config.channelId,
                    eventType: 'live',
                    type: 'video',
                    key: this.config.apiKey,
                    maxResults: 1
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

    // Get live chat ID from video
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

    // Clean up when stream ends
    cleanup() {
        this.videoId = null;
        this.liveChatId = null;
        this.nextPageToken = null;
        this.isRunning = false;
    }

    // Start continuous monitoring
    async startContinuousMonitoring() {
        console.log('🤖 YouTube Chat Bot - Cloud Edition');
        console.log('===================================');
        console.log(`🔧 Bot Name: ${this.config.botName}`);
        console.log(`📺 Channel ID: ${this.config.channelId}`);
        console.log('🔍 Monitoring for live streams...\n');
        
        // Check for streams every 2 minutes
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
        }, 2 * 60 * 1000); // Check every 2 minutes

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

    // Poll for new chat messages
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
            
            // Wait before next poll
            const pollInterval = Math.max(response.data.pollingIntervalMillis || 5000, 2000);
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
            setTimeout(() => this.pollMessages(), 10000);
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

        // Rate limiting - don't respond too frequently
        const now = Date.now();
        if (now - this.lastResponseTime < 3000) return; // Wait 3 seconds between responses

        // Generate response
        const response = this.generateResponse(textLower, author);
        
        if (response) {
            this.lastResponseTime = now;
            // Random delay to seem more human (1-4 seconds)
            const delay = Math.random() * 3000 + 1000;
            setTimeout(() => this.sendMessage(response), delay);
        }
    }

    // Generate appropriate response
    generateResponse(text, author) {
        // Admin commands for bot owner
        if (author === this.config.ownerUsername) {
            if (text === '!status') {
                return `🤖 Bot Status: Active | Stream: ${this.videoId || 'none'} | Uptime: ${Math.floor(process.uptime() / 60)}min`;
            }
            if (text === '!ping') {
                return '🏓 Pong!';
            }
            if (text.startsWith('!say ')) {
                return text.substring(5); // Remove "!say " prefix
            }
        }

        // First-time chatters get a warm welcome
        if (this.containsGreeting(text)) {
            return this.getRandomResponse(this.responses.greetings);
        }

        // Game reactions based on keywords
        if (text.includes('amazing') || text.includes('awesome') || text.includes('incredible') || text.includes('insane')) {
            return this.getRandomResponse(this.responses.reactions.amazing);
        }

        if (text.includes('fail') || text.includes('died') || text.includes('dead') || text.includes('rip')) {
            return this.getRandomResponse(this.responses.reactions.fail);
        }

        if (text.includes('clutch') || text.includes('close') || text.includes('barely') || text.includes('1hp')) {
            return this.getRandomResponse(this.responses.reactions.clutch);
        }

        if (text.includes('lol') || text.includes('funny') || text.includes('haha') || text.includes('lmao')) {
            return this.getRandomResponse(this.responses.reactions.funny);
        }

        if (text.includes('give up') || text.includes('hard') || text.includes('difficult')) {
            return this.getRandomResponse(this.responses.encouragement);
        }

        // Common questions
        if (text.includes('how are you') || text.includes('how you doing')) {
            return "I'm doing great! Thanks for asking! How are you enjoying the stream? 😊";
        }

        if (text.includes('what game') || text.includes('game name')) {
            return "This game looks amazing! I love watching these streams! 🎮";
        }

        if (text.includes('bot') && (text.includes('are you') || text.includes('real'))) {
            return "Yep, I'm a bot! 🤖 But I'm here to hang out and enjoy the stream with everyone!";
        }

        // New follower celebrations
        if (text.includes('new follower') || text.includes('just followed')) {
            return "Welcome to the community! 🎉";
        }

        // Randomly engage with active chat (2% chance)
        if (Math.random() < 0.02) {
            const randomEngagements = [
                `Hey ${author}! 👋`,
                "This stream is so good! 🔥",
                "Anyone else loving this gameplay?",
                "Chat is so active today! Love it! ❤️"
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

    // Send message to chat
    async sendMessage(message) {
        // Check if we have OAuth tokens to send messages
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
        console.warn('💡 Run locally first to get OAuth tokens, then add them to environment.');
    }
}

// Main function
async function main() {
    try {
        // Validate environment
        validateEnvironment();
        
        // Start bot
        const bot = new YouTubeChatBot();
        await bot.startContinuousMonitoring();
        
        console.log('✅ Bot is running in cloud mode!');
        console.log('🔄 Will automatically connect when you go live');
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