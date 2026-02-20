/**
 * 数据存储模块
 * 负责游戏数据的本地存储和读取
 */

class StorageManager {
    constructor() {
        this.prefix = 'snake_game_';
        this.highScoreKey = this.prefix + 'highScore';
        this.leaderboardKey = this.prefix + 'leaderboard';
        this.achievementsKey = this.prefix + 'achievements';
        this.settingsKey = this.prefix + 'settings';
        this.statsKey = this.prefix + 'stats';
        
        // 初始化成就系统
        this.defaultAchievements = [
            { id: 'first_blood', name: '首战告捷', description: '完成第一次游戏', icon: '🎮', unlocked: false },
            { id: 'score_100', name: '百分高手', description: '单次得分达到 100 分', icon: '💯', unlocked: false },
            { id: 'score_500', name: '五百达人', description: '单次得分达到 500 分', icon: '🔥', unlocked: false },
            { id: 'score_1000', name: '千分王者', description: '单次得分达到 1000 分', icon: '👑', unlocked: false },
            { id: 'snake_length_10', name: '小试牛刀', description: '蛇长度达到 10', icon: '🐍', unlocked: false },
            { id: 'snake_length_20', name: '长蛇阵', description: '蛇长度达到 20', icon: '🐉', unlocked: false },
            { id: 'games_10', name: '熟能生巧', description: '进行 10 次游戏', icon: '⭐', unlocked: false },
            { id: 'games_50', name: '游戏达人', description: '进行 50 次游戏', icon: '🏅', unlocked: false },
            { id: 'games_100', name: '传奇玩家', description: '进行 100 次游戏', icon: '🏆', unlocked: false },
            { id: 'no_death_5min', name: '生存大师', description: '生存超过 5 分钟', icon: '⏱️', unlocked: false }
        ];
        
        // 初始化设置
        this.defaultSettings = {
            sound: true,
            music: true,
            vibration: true,
            showGrid: true,
            theme: 'neon',
            difficulty: 'normal',
            mode: 'classic'
        };
        
        // 初始化统计数据
        this.defaultStats = {
            totalGames: 0,
            totalTime: 0,
            totalScore: 0,
            maxSnakeLength: 0,
            gamesPlayed: 0
        };
        
        this.init();
    }
    
    init() {
        // 初始化成就
        if (!localStorage.getItem(this.achievementsKey)) {
            this.saveAchievements(this.defaultAchievements);
        }
        
        // 初始化设置
        if (!localStorage.getItem(this.settingsKey)) {
            this.saveSettings(this.defaultSettings);
        }
        
        // 初始化统计
        if (!localStorage.getItem(this.statsKey)) {
            this.saveStats(this.defaultStats);
        }
        
        // 初始化排行榜
        if (!localStorage.getItem(this.leaderboardKey)) {
            this.saveLeaderboard([]);
        }
    }
    
    // ========== 最高分管理 ==========
    getHighScore() {
        return parseInt(localStorage.getItem(this.highScoreKey)) || 0;
    }
    
    setHighScore(score) {
        const currentHigh = this.getHighScore();
        if (score > currentHigh) {
            localStorage.setItem(this.highScoreKey, score);
            return true; // 新纪录
        }
        return false;
    }
    
    // ========== 排行榜管理 ==========
    getLeaderboard() {
        const data = localStorage.getItem(this.leaderboardKey);
        return data ? JSON.parse(data) : [];
    }
    
    saveLeaderboard(leaderboard) {
        // 只保留前 10 名
        const sorted = leaderboard.sort((a, b) => b.score - a.score).slice(0, 10);
        localStorage.setItem(this.leaderboardKey, JSON.stringify(sorted));
    }
    
    addToLeaderboard(name, score, mode, date) {
        const leaderboard = this.getLeaderboard();
        leaderboard.push({
            name: name || '玩家',
            score: score,
            mode: mode,
            date: date || new Date().toLocaleDateString()
        });
        this.saveLeaderboard(leaderboard);
    }
    
    // ========== 成就管理 ==========
    getAchievements() {
        const data = localStorage.getItem(this.achievementsKey);
        return data ? JSON.parse(data) : this.defaultAchievements;
    }
    
    saveAchievements(achievements) {
        localStorage.setItem(this.achievementsKey, JSON.stringify(achievements));
    }
    
    unlockAchievement(id) {
        const achievements = this.getAchievements();
        const achievement = achievements.find(a => a.id === id);
        if (achievement && !achievement.unlocked) {
            achievement.unlocked = true;
            this.saveAchievements(achievements);
            return true; // 新解锁
        }
        return false;
    }
    
    checkAchievements(stats) {
        const unlocked = [];
        
        // 首战告捷
        if (stats.gamesPlayed >= 1) {
            if (this.unlockAchievement('first_blood')) unlocked.push('首战告捷');
        }
        
        // 分数成就
        if (stats.maxScore >= 100) {
            if (this.unlockAchievement('score_100')) unlocked.push('百分高手');
        }
        if (stats.maxScore >= 500) {
            if (this.unlockAchievement('score_500')) unlocked.push('五百达人');
        }
        if (stats.maxScore >= 1000) {
            if (this.unlockAchievement('score_1000')) unlocked.push('千分王者');
        }
        
        // 蛇长度成就
        if (stats.maxSnakeLength >= 10) {
            if (this.unlockAchievement('snake_length_10')) unlocked.push('小试牛刀');
        }
        if (stats.maxSnakeLength >= 20) {
            if (this.unlockAchievement('snake_length_20')) unlocked.push('长蛇阵');
        }
        
        // 游戏次数成就
        if (stats.gamesPlayed >= 10) {
            if (this.unlockAchievement('games_10')) unlocked.push('熟能生巧');
        }
        if (stats.gamesPlayed >= 50) {
            if (this.unlockAchievement('games_50')) unlocked.push('游戏达人');
        }
        if (stats.gamesPlayed >= 100) {
            if (this.unlockAchievement('games_100')) unlocked.push('传奇玩家');
        }
        
        return unlocked;
    }
    
    // ========== 设置管理 ==========
    getSettings() {
        const data = localStorage.getItem(this.settingsKey);
        return data ? JSON.parse(data) : this.defaultSettings;
    }
    
    saveSettings(settings) {
        localStorage.setItem(this.settingsKey, JSON.stringify(settings));
    }
    
    updateSetting(key, value) {
        const settings = this.getSettings();
        settings[key] = value;
        this.saveSettings(settings);
    }
    
    // ========== 统计管理 ==========
    getStats() {
        const data = localStorage.getItem(this.statsKey);
        return data ? JSON.parse(data) : this.defaultStats;
    }
    
    saveStats(stats) {
        localStorage.setItem(this.statsKey, JSON.stringify(stats));
    }
    
    updateStats(gameStats) {
        const stats = this.getStats();
        stats.totalGames += 1;
        stats.totalTime += gameStats.playTime || 0;
        stats.totalScore += gameStats.score || 0;
        stats.gamesPlayed += 1;
        if (gameStats.snakeLength > stats.maxSnakeLength) {
            stats.maxSnakeLength = gameStats.snakeLength;
        }
        if (gameStats.score > (stats.maxScore || 0)) {
            stats.maxScore = gameStats.score;
        }
        this.saveStats(stats);
        return stats;
    }
    
    // ========== 清空数据 ==========
    clearAll() {
        localStorage.removeItem(this.highScoreKey);
        localStorage.removeItem(this.leaderboardKey);
        localStorage.removeItem(this.achievementsKey);
        localStorage.removeItem(this.settingsKey);
        localStorage.removeItem(this.statsKey);
        this.init();
    }
}

// 创建全局实例
const storage = new StorageManager();
