/**
 * 游戏核心逻辑模块
 * 贪吃蛇游戏的主要逻辑实现
 */

class SnakeGame {
    constructor() {
        // Canvas 设置
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.resizeCanvas();
        
        // 游戏状态
        this.isRunning = false;
        this.isPaused = false;
        this.isGameOver = false;
        
        // 游戏配置
        this.gridSize = 20;
        this.tileCount = 0;
        this.baseSpeed = 150;
        this.currentSpeed = 150;
        this.speedMultiplier = 1;
        
        // 游戏数据
        this.snake = [];
        this.food = {};
        this.specialFoods = [];
        this.score = 0;
        this.highScore = storage.getHighScore();
        this.gameMode = 'classic';
        this.difficulty = 'normal';
        this.timeLeft = 60;
        this.startTime = 0;
        
        // 控制器
        this.controller = new Controller(this);
        
        // 特效
        effects.setCanvas(this.canvas);
        
        // 动画帧
        this.lastUpdate = 0;
        this.animationId = null;
        
        // UI 元素
        this.ui = {
            score: document.getElementById('score'),
            highScore: document.getElementById('highScore'),
            timeLeft: document.getElementById('timeLeft'),
            timeDisplay: document.getElementById('timeDisplay'),
            modeInfo: document.getElementById('modeInfo'),
            speedInfo: document.getElementById('speedInfo'),
            finalScore: document.getElementById('finalScore'),
            newHighScore: document.getElementById('newHighScore'),
            startMenu: document.getElementById('startMenu'),
            gameScreen: document.getElementById('gameScreen'),
            pauseMenu: document.getElementById('pauseMenu'),
            gameOverMenu: document.getElementById('gameOverMenu'),
            leaderboardMenu: document.getElementById('leaderboardMenu'),
            achievementsMenu: document.getElementById('achievementsMenu'),
            settingsMenu: document.getElementById('settingsMenu')
        };
        
        // 初始化
        this.init();
    }
    
    // ========== 初始化 ==========
    init() {
        this.updateHighScoreDisplay();
        this.bindEvents();
        this.loadSettings();
        this.applyTheme();
        
        // 初始绘制
        this.draw();
    }
    
    // ========== 事件绑定 ==========
    bindEvents() {
        // 开始游戏按钮
        document.getElementById('startGameBtn').addEventListener('click', () => {
            effects.vibrateButton();
            this.startGame();
        });
        
        // 暂停按钮
        document.getElementById('pauseBtn').addEventListener('click', () => {
            effects.vibrateButton();
            this.togglePause();
        });
        
        // 继续按钮
        document.getElementById('resumeBtn').addEventListener('click', () => {
            effects.vibrateButton();
            this.togglePause();
        });
        
        // 重新开始按钮
        document.getElementById('restartBtn').addEventListener('click', () => {
            effects.vibrateButton();
            this.startGame();
        });
        
        // 退出按钮
        document.getElementById('quitBtn').addEventListener('click', () => {
            effects.vibrateButton();
            this.quitGame();
        });
        
        // 再玩一次按钮
        document.getElementById('playAgainBtn').addEventListener('click', () => {
            effects.vibrateButton();
            this.startGame();
        });
        
        // 返回菜单按钮
        document.getElementById('backToMenuBtn').addEventListener('click', () => {
            effects.vibrateButton();
            this.showMenu();
        });
        
        // 排行榜按钮
        document.getElementById('showLeaderboardBtn').addEventListener('click', () => {
            effects.vibrateButton();
            this.showLeaderboard();
        });
        
        document.getElementById('closeLeaderboardBtn').addEventListener('click', () => {
            effects.vibrateButton();
            this.hideMenu('leaderboardMenu');
        });
        
        // 成就按钮
        document.getElementById('showAchievementsBtn').addEventListener('click', () => {
            effects.vibrateButton();
            this.showAchievements();
        });
        
        document.getElementById('closeAchievementsBtn').addEventListener('click', () => {
            effects.vibrateButton();
            this.hideMenu('achievementsMenu');
        });
        
        // 设置按钮
        document.getElementById('showSettingsBtn').addEventListener('click', () => {
            effects.vibrateButton();
            this.showSettings();
        });
        
        document.getElementById('closeSettingsBtn').addEventListener('click', () => {
            effects.vibrateButton();
            this.hideMenu('settingsMenu');
        });
        
        // 模式选择
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                effects.vibrateButton();
                document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.gameMode = btn.dataset.mode;
            });
        });
        
        // 难度选择
        document.querySelectorAll('.diff-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                effects.vibrateButton();
                document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.difficulty = btn.dataset.diff;
                this.applyDifficulty();
            });
        });
        
        // 主题选择
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                effects.vibrateButton();
                document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                storage.updateSetting('theme', btn.dataset.theme);
                this.applyTheme();
            });
        });
        
        // 设置选项
        document.getElementById('soundToggle').addEventListener('change', (e) => {
            storage.updateSetting('sound', e.target.checked);
            effects.updateSettings();
        });
        
        document.getElementById('musicToggle').addEventListener('change', (e) => {
            storage.updateSetting('music', e.target.checked);
            effects.updateSettings();
        });
        
        document.getElementById('vibrationToggle').addEventListener('change', (e) => {
            storage.updateSetting('vibration', e.target.checked);
            effects.updateSettings();
        });
        
        document.getElementById('gridToggle').addEventListener('change', (e) => {
            storage.updateSetting('showGrid', e.target.checked);
        });
        
        // 窗口大小变化
        window.addEventListener('resize', () => {
            this.resizeCanvas();
            this.draw();
        });
    }
    
    // ========== 画布调整 ==========
    resizeCanvas() {
        const maxWidth = Math.min(window.innerWidth - 40, 400);
        const maxHeight = Math.min(window.innerHeight * 0.5, 400);
        const size = Math.min(maxWidth, maxHeight);
        
        // 确保是 gridSize 的倍数
        const adjustedSize = Math.floor(size / this.gridSize) * this.gridSize;
        
        this.canvas.width = adjustedSize;
        this.canvas.height = adjustedSize;
        this.tileCount = adjustedSize / this.gridSize;
    }
    
    // ========== 难度设置 ==========
    applyDifficulty() {
        const difficulties = {
            easy: { speed: 200, scoreMultiplier: 1 },
            normal: { speed: 150, scoreMultiplier: 1.5 },
            hard: { speed: 100, scoreMultiplier: 2 }
        };
        
        const diff = difficulties[this.difficulty];
        this.baseSpeed = diff.speed;
        this.scoreMultiplier = diff.scoreMultiplier;
        storage.updateSetting('difficulty', this.difficulty);
    }
    
    // ========== 主题应用 ==========
    applyTheme() {
        const theme = storage.getSettings().theme;
        document.body.className = `theme-${theme}`;
        
        // 更新主题按钮状态
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === theme);
        });
    }
    
    // ========== 加载设置 ==========
    loadSettings() {
        const settings = storage.getSettings();
        this.gameMode = settings.mode || 'classic';
        this.difficulty = settings.difficulty || 'normal';
        
        // 更新 UI 状态
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === this.gameMode);
        });
        
        document.querySelectorAll('.diff-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.diff === this.difficulty);
        });
        
        // 设置复选框
        document.getElementById('soundToggle').checked = settings.sound;
        document.getElementById('musicToggle').checked = settings.music;
        document.getElementById('vibrationToggle').checked = settings.vibration;
        document.getElementById('gridToggle').checked = settings.showGrid;
        
        this.applyDifficulty();
    }
    
    // ========== 游戏开始 ==========
    startGame() {
        this.hideAllMenus();
        this.ui.gameScreen.classList.add('active');
        
        // 重置游戏状态
        this.isRunning = true;
        this.isPaused = false;
        this.isGameOver = false;
        this.score = 0;
        this.currentSpeed = this.baseSpeed;
        this.speedMultiplier = 1;
        this.specialFoods = [];
        
        // 初始化蛇
        const startX = Math.floor(this.tileCount / 2);
        const startY = Math.floor(this.tileCount / 2);
        this.snake = [
            { x: startX, y: startY },
            { x: startX - 1, y: startY },
            { x: startX - 2, y: startY }
        ];
        
        // 重置控制器方向
        this.controller.resetDirection();
        
        // 放置食物
        this.placeFood();
        
        // 更新 UI
        this.updateScoreDisplay();
        this.ui.modeInfo.textContent = this.getModeName();
        
        // 计时模式
        if (this.gameMode === 'timed') {
            this.timeLeft = 60;
            this.ui.timeDisplay.style.display = 'block';
            this.updateTimeDisplay();
        } else {
            this.ui.timeDisplay.style.display = 'none';
        }
        
        // 播放开始音效
        effects.playSound('start');
        
        // 开始游戏循环
        this.startTime = Date.now();
        this.lastUpdate = 0;
        
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
        this.gameLoop(0);
    }
    
    // ========== 游戏循环 ==========
    gameLoop(timestamp) {
        if (!this.isRunning) return;
        
        this.animationId = requestAnimationFrame((ts) => this.gameLoop(ts));
        
        if (this.isPaused) return;
        
        // 计时模式时间更新
        if (this.gameMode === 'timed') {
            const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
            this.timeLeft = Math.max(0, 60 - elapsed);
            this.updateTimeDisplay();
            
            if (this.timeLeft <= 0) {
                this.gameOver();
                return;
            }
        }
        
        // 控制游戏速度
        const deltaTime = timestamp - this.lastUpdate;
        if (deltaTime < this.currentSpeed) return;
        
        this.lastUpdate = timestamp;
        
        // 更新游戏状态
        this.update();
        this.draw();
    }
    
    // ========== 游戏更新 ==========
    update() {
        // 更新方向
        const direction = this.controller.updateDirection();
        
        // 计算新头部位置
        const head = {
            x: this.snake[0].x + direction.x,
            y: this.snake[0].y + direction.y
        };
        
        // 撞墙检测
        if (head.x < 0 || head.x >= this.tileCount || 
            head.y < 0 || head.y >= this.tileCount) {
            this.gameOver();
            return;
        }
        
        // 撞自己检测
        if (this.snake.some(seg => seg.x === head.x && seg.y === head.y)) {
            this.gameOver();
            return;
        }
        
        // 移动蛇
        this.snake.unshift(head);
        
        // 吃食物检测
        let ateFood = false;
        
        // 普通食物
        if (head.x === this.food.x && head.y === this.food.y) {
            this.score += 10 * this.scoreMultiplier;
            this.updateScoreDisplay();
            this.placeFood();
            ateFood = true;
            
            // 特效
            const foodX = head.x * this.gridSize + this.gridSize / 2;
            const foodY = head.y * this.gridSize + this.gridSize / 2;
            effects.createExplosion(foodX, foodY, '#ff0055');
            effects.playSound('eat');
            effects.vibrateEat();
            
            // 加速
            if (this.currentSpeed > 50) {
                this.currentSpeed -= 2;
            }
            
            // 更新速度显示
            this.speedMultiplier = this.baseSpeed / this.currentSpeed;
            this.ui.speedInfo.textContent = `速度：${this.speedMultiplier.toFixed(1)}x`;
        }
        
        // 特殊食物检测
        for (let i = this.specialFoods.length - 1; i >= 0; i--) {
            const sf = this.specialFoods[i];
            if (head.x === sf.x && head.y === sf.y) {
                this.activateSpecialFood(sf);
                this.specialFoods.splice(i, 1);
                ateFood = true;
            }
        }
        
        // 没吃到食物则移除尾部
        if (!ateFood) {
            this.snake.pop();
        }
        
        // 更新粒子效果
        effects.updateParticles();
    }
    
    // ========== 游戏绘制 ==========
    draw() {
        const settings = storage.getSettings();
        const colors = this.getThemeColors();
        
        // 清空画布
        this.ctx.fillStyle = colors.canvasBg;
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // 绘制网格
        if (settings.showGrid) {
            this.ctx.strokeStyle = colors.gridColor;
            this.ctx.lineWidth = 0.5;
            for (let i = 0; i <= this.tileCount; i++) {
                this.ctx.beginPath();
                this.ctx.moveTo(i * this.gridSize, 0);
                this.ctx.lineTo(i * this.gridSize, this.canvas.height);
                this.ctx.stroke();
                this.ctx.beginPath();
                this.ctx.moveTo(0, i * this.gridSize);
                this.ctx.lineTo(this.canvas.width, i * this.gridSize);
                this.ctx.stroke();
            }
        }
        
        // 绘制食物
        this.drawFood(colors);
        
        // 绘制特殊食物
        this.specialFoods.forEach(sf => {
            this.drawSpecialFood(sf, colors);
        });
        
        // 绘制蛇
        this.drawSnake(colors);
        
        // 绘制粒子效果
        effects.drawParticles();
    }
    
    // ========== 绘制蛇 ==========
    drawSnake(colors) {
        this.snake.forEach((segment, index) => {
            const x = segment.x * this.gridSize;
            const y = segment.y * this.gridSize;
            const isHead = index === 0;
            
            // 蛇身颜色
            const color = isHead ? colors.snakeHead : colors.snakeBody;
            
            // 绘制蛇身
            this.ctx.fillStyle = color;
            this.ctx.shadowBlur = isHead ? 15 : 5;
            this.ctx.shadowColor = color;
            
            // 圆角矩形
            const radius = 4;
            this.ctx.beginPath();
            this.ctx.roundRect(x + 1, y + 1, this.gridSize - 2, this.gridSize - 2, radius);
            this.ctx.fill();
            
            // 绘制蛇眼（仅头部）
            if (isHead) {
                this.ctx.shadowBlur = 0;
                this.ctx.fillStyle = '#fff';
                
                const direction = this.controller.getDirection();
                let eyeOffsetX = 0, eyeOffsetY = 0;
                
                if (direction.x === 1) eyeOffsetX = 4;
                else if (direction.x === -1) eyeOffsetX = -4;
                else if (direction.y === 1) eyeOffsetY = 4;
                else if (direction.y === -1) eyeOffsetY = -4;
                
                const eyeSize = 3;
                const eyeSpacing = 5;
                
                // 左眼
                this.ctx.fillRect(
                    x + this.gridSize / 2 - eyeSpacing + eyeOffsetX,
                    y + this.gridSize / 2 - eyeSpacing + eyeOffsetY,
                    eyeSize, eyeSize
                );
                
                // 右眼
                this.ctx.fillRect(
                    x + this.gridSize / 2 + eyeSpacing - eyeSize + eyeOffsetX,
                    y + this.gridSize / 2 - eyeSpacing + eyeOffsetY,
                    eyeSize, eyeSize
                );
            }
        });
        
        this.ctx.shadowBlur = 0;
    }
    
    // ========== 绘制食物 ==========
    drawFood(colors) {
        const x = this.food.x * this.gridSize + this.gridSize / 2;
        const y = this.food.y * this.gridSize + this.gridSize / 2;
        
        this.ctx.fillStyle = colors.foodColor;
        this.ctx.shadowBlur = 15;
        this.ctx.shadowColor = colors.foodColor;
        
        this.ctx.beginPath();
        this.ctx.arc(x, y, this.gridSize / 2 - 2, 0, Math.PI * 2);
        this.ctx.fill();
        
        this.ctx.shadowBlur = 0;
    }
    
    // ========== 绘制特殊食物 ==========
    drawSpecialFood(sf, colors) {
        const x = sf.x * this.gridSize + this.gridSize / 2;
        const y = sf.y * this.gridSize + this.gridSize / 2;
        
        this.ctx.fillStyle = sf.color;
        this.ctx.shadowBlur = 15;
        this.ctx.shadowColor = sf.color;
        
        // 脉冲效果
        const pulse = 1 + Math.sin(Date.now() / 100) * 0.2;
        
        this.ctx.beginPath();
        if (sf.type === 'bonus') {
            // 星形
            this.drawStar(x, y, 5, this.gridSize / 2 * pulse, this.gridSize / 4 * pulse);
        } else if (sf.type === 'slow') {
            // 圆形带边框
            this.ctx.arc(x, y, this.gridSize / 2 * pulse, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.strokeStyle = '#fff';
            this.ctx.lineWidth = 2;
            this.ctx.stroke();
        } else if (sf.type === 'fast') {
            // 三角形
            this.drawTriangle(x, y, this.gridSize / 2 * pulse);
        }
        this.ctx.fill();
        
        this.ctx.shadowBlur = 0;
    }
    
    drawStar(cx, cy, spikes, outerRadius, innerRadius) {
        let rot = Math.PI / 2 * 3;
        let x = cx;
        let y = cy;
        let step = Math.PI / spikes;
        
        this.ctx.beginPath();
        this.ctx.moveTo(cx, cy - outerRadius);
        
        for (let i = 0; i < spikes; i++) {
            x = cx + Math.cos(rot) * outerRadius;
            y = cy + Math.sin(rot) * outerRadius;
            this.ctx.lineTo(x, y);
            rot += step;
            
            x = cx + Math.cos(rot) * innerRadius;
            y = cy + Math.sin(rot) * innerRadius;
            this.ctx.lineTo(x, y);
            rot += step;
        }
        
        this.ctx.lineTo(cx, cy - outerRadius);
        this.ctx.closePath();
    }
    
    drawTriangle(cx, cy, size) {
        this.ctx.beginPath();
        this.ctx.moveTo(cx, cy - size);
        this.ctx.lineTo(cx + size, cy + size);
        this.ctx.lineTo(cx - size, cy + size);
        this.ctx.closePath();
    }
    
    // ========== 放置食物 ==========
    placeFood() {
        let validPosition = false;
        
        while (!validPosition) {
            this.food = {
                x: Math.floor(Math.random() * this.tileCount),
                y: Math.floor(Math.random() * this.tileCount)
            };
            
            // 确保不在蛇身上
            validPosition = !this.snake.some(seg => 
                seg.x === this.food.x && seg.y === this.food.y
            );
        }
        
        // 随机生成特殊食物（5% 概率）
        if (Math.random() < 0.05 && this.specialFoods.length < 2) {
            this.spawnSpecialFood();
        }
    }
    
    // ========== 生成特殊食物 ==========
    spawnSpecialFood() {
        const types = [
            { type: 'bonus', color: '#ffaa00', points: 50, duration: 0 },
            { type: 'slow', color: '#00d4ff', points: 20, duration: 5000 },
            { type: 'fast', color: '#ff00ff', points: 30, duration: 3000 }
        ];
        
        const sfType = types[Math.floor(Math.random() * types.length)];
        
        let validPosition = false;
        let position = {};
        
        while (!validPosition) {
            position = {
                x: Math.floor(Math.random() * this.tileCount),
                y: Math.floor(Math.random() * this.tileCount)
            };
            
            validPosition = !this.snake.some(seg => 
                seg.x === position.x && seg.y === position.y
            ) && !(position.x === this.food.x && position.y === this.food.y);
        }
        
        this.specialFoods.push({
            ...sfType,
            x: position.x,
            y: position.y,
            spawnTime: Date.now()
        });
    }
    
    // ========== 激活特殊食物效果 ==========
    activateSpecialFood(sf) {
        this.score += sf.points * this.scoreMultiplier;
        this.updateScoreDisplay();
        effects.playSound('eat');
        effects.vibrateEat();
        
        const foodX = sf.x * this.gridSize + this.gridSize / 2;
        const foodY = sf.y * this.gridSize + this.gridSize / 2;
        effects.createExplosion(foodX, foodY, sf.color, 20);
        
        if (sf.type === 'slow') {
            this.currentSpeed = Math.min(this.currentSpeed + 30, 300);
            setTimeout(() => {
                this.currentSpeed = this.baseSpeed;
            }, sf.duration);
        } else if (sf.type === 'fast') {
            this.currentSpeed = Math.max(this.currentSpeed - 30, 40);
            setTimeout(() => {
                this.currentSpeed = this.baseSpeed;
            }, sf.duration);
        }
    }
    
    // ========== 游戏结束 ==========
    gameOver() {
        this.isRunning = false;
        this.isGameOver = true;
        
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
        
        // 播放结束音效
        effects.playSound('gameOver');
        effects.vibrateGameOver();
        effects.flashScreen('rgba(255, 0, 85, 0.3)');
        
        // 计算游戏时间
        const playTime = (Date.now() - this.startTime) / 1000;
        
        // 更新统计数据
        const gameStats = {
            score: this.score,
            snakeLength: this.snake.length,
            playTime: playTime
        };
        const stats = storage.updateStats(gameStats);
        
        // 检查成就
        const newAchievements = storage.checkAchievements(stats);
        if (newAchievements.length > 0) {
            effects.playSound('unlock');
            // 可以显示成就解锁通知
        }
        
        // 更新最高分
        const isNewRecord = storage.setHighScore(this.score);
        
        // 添加到排行榜
        storage.addToLeaderboard('玩家', this.score, this.gameMode);
        
        // 更新 UI
        this.ui.finalScore.textContent = this.score;
        this.ui.newHighScore.style.display = isNewRecord ? 'block' : 'none';
        this.updateHighScoreDisplay();
        
        // 显示游戏结束菜单
        setTimeout(() => {
            this.ui.gameOverMenu.classList.add('active');
        }, 500);
    }
    
    // ========== 暂停/继续 ==========
    togglePause() {
        if (!this.isRunning || this.isGameOver) return;
        
        this.isPaused = !this.isPaused;
        effects.playSound('pause');
        
        if (this.isPaused) {
            this.ui.pauseMenu.classList.add('active');
        } else {
            this.ui.pauseMenu.classList.remove('active');
            this.lastUpdate = performance.now();
        }
    }
    
    // ========== 退出游戏 ==========
    quitGame() {
        this.isRunning = false;
        this.isPaused = false;
        
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
        
        this.ui.pauseMenu.classList.remove('active');
        this.showMenu();
    }
    
    // ========== 显示菜单 ==========
    showMenu() {
        this.hideAllMenus();
        this.ui.startMenu.classList.add('active');
        this.ui.gameScreen.classList.remove('active');
    }
    
    hideAllMenus() {
        document.querySelectorAll('.menu').forEach(menu => {
            menu.classList.remove('active');
        });
    }
    
    hideMenu(menuId) {
        document.getElementById(menuId).classList.remove('active');
    }
    
    // ========== 显示排行榜 ==========
    showLeaderboard() {
        const leaderboard = storage.getLeaderboard();
        const listEl = document.getElementById('leaderboardList');
        
        if (leaderboard.length === 0) {
            listEl.innerHTML = '<p style="color:#888;text-align:center;">暂无记录</p>';
        } else {
            listEl.innerHTML = leaderboard.map((entry, index) => `
                <div class="leaderboard-item ${index < 3 ? 'top3' : ''}">
                    <span class="rank">#${index + 1} ${entry.name}</span>
                    <span class="mode">${this.getModeName(entry.mode)}</span>
                    <span class="score">${entry.score}</span>
                </div>
            `).join('');
        }
        
        this.ui.leaderboardMenu.classList.add('active');
    }
    
    // ========== 显示成就 ==========
    showAchievements() {
        const achievements = storage.getAchievements();
        const listEl = document.getElementById('achievementsList');
        
        listEl.innerHTML = achievements.map(ach => `
            <div class="achievement-item ${ach.unlocked ? 'unlocked' : 'locked'}">
                <span class="achievement-icon">${ach.icon}</span>
                <div class="achievement-info">
                    <h4>${ach.name}</h4>
                    <p>${ach.description}</p>
                </div>
            </div>
        `).join('');
        
        this.ui.achievementsMenu.classList.add('active');
    }
    
    // ========== 显示设置 ==========
    showSettings() {
        const settings = storage.getSettings();
        document.getElementById('soundToggle').checked = settings.sound;
        document.getElementById('musicToggle').checked = settings.music;
        document.getElementById('vibrationToggle').checked = settings.vibration;
        document.getElementById('gridToggle').checked = settings.showGrid;
        
        this.ui.settingsMenu.classList.add('active');
    }
    
    // ========== 工具方法 ==========
    updateScoreDisplay() {
        this.ui.score.textContent = Math.floor(this.score);
    }
    
    updateHighScoreDisplay() {
        this.highScore = storage.getHighScore();
        this.ui.highScore.textContent = this.highScore;
    }
    
    updateTimeDisplay() {
        this.ui.timeLeft.textContent = this.timeLeft;
        if (this.timeLeft <= 10) {
            this.ui.timeLeft.style.color = '#ff0055';
        } else {
            this.ui.timeLeft.style.color = '#00ff88';
        }
    }
    
    getModeName(mode) {
        const names = {
            classic: '经典模式',
            timed: '计时模式',
            endless: '无尽模式'
        };
        return names[mode || this.gameMode] || '经典模式';
    }
    
    getThemeColors() {
        const settings = storage.getSettings();
        const themeColors = {
            neon: {
                canvasBg: '#0a0a15',
                gridColor: '#1a1a2e',
                snakeHead: '#00ff88',
                snakeBody: '#00cc6a',
                foodColor: '#ff0055'
            },
            dark: {
                canvasBg: '#000000',
                gridColor: '#1a1a1a',
                snakeHead: '#9d4edd',
                snakeBody: '#7b2cbf',
                foodColor: '#ff006e'
            },
            retro: {
                canvasBg: '#001a00',
                gridColor: '#003300',
                snakeHead: '#00ff00',
                snakeBody: '#00cc00',
                foodColor: '#ff6600'
            },
            ocean: {
                canvasBg: '#001a33',
                gridColor: '#003366',
                snakeHead: '#00d4ff',
                snakeBody: '#0099cc',
                foodColor: '#ff6b6b'
            }
        };
        return themeColors[settings.theme] || themeColors.neon;
    }
}

// 创建游戏实例
const game = new SnakeGame();
