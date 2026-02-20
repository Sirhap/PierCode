/**
 * 输入控制模块
 * 负责处理键盘、触屏和手势输入
 */

class Controller {
    constructor(game) {
        this.game = game;
        this.direction = { x: 1, y: 0 };
        this.nextDirection = { x: 1, y: 0 };
        this.touchStartX = 0;
        this.touchStartY = 0;
        
        this.initKeyboard();
        this.initTouchControls();
        this.initSwipeControls();
    }
    
    // ========== 键盘控制 ==========
    initKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (!this.game.isRunning) return;
            
            switch (e.key) {
                case 'ArrowUp':
                case 'w':
                case 'W':
                    if (this.direction.y !== 1) {
                        this.nextDirection = { x: 0, y: -1 };
                    }
                    e.preventDefault();
                    break;
                    
                case 'ArrowDown':
                case 's':
                case 'S':
                    if (this.direction.y !== -1) {
                        this.nextDirection = { x: 0, y: 1 };
                    }
                    e.preventDefault();
                    break;
                    
                case 'ArrowLeft':
                case 'a':
                case 'A':
                    if (this.direction.x !== 1) {
                        this.nextDirection = { x: -1, y: 0 };
                    }
                    e.preventDefault();
                    break;
                    
                case 'ArrowRight':
                case 'd':
                case 'D':
                    if (this.direction.x !== -1) {
                        this.nextDirection = { x: 1, y: 0 };
                    }
                    e.preventDefault();
                    break;
                    
                case ' ':
                case 'Escape':
                    this.game.togglePause();
                    e.preventDefault();
                    break;
            }
        });
    }
    
    // ========== 触屏按钮控制 ==========
    initTouchControls() {
        const dirBtns = document.querySelectorAll('.dir-btn');
        dirBtns.forEach(btn => {
            btn.addEventListener('touchstart', (e) => {
                e.preventDefault();
                effects.vibrateButton();
                this.handleDirectionInput(btn.dataset.dir);
            });
            
            btn.addEventListener('click', (e) => {
                if (!this.game.isRunning) return;
                effects.vibrateButton();
                this.handleDirectionInput(btn.dataset.dir);
            });
        });
    }
    
    handleDirectionInput(dir) {
        if (!this.game.isRunning) return;
        
        switch (dir) {
            case 'up':
                if (this.direction.y !== 1) {
                    this.nextDirection = { x: 0, y: -1 };
                }
                break;
            case 'down':
                if (this.direction.y !== -1) {
                    this.nextDirection = { x: 0, y: 1 };
                }
                break;
            case 'left':
                if (this.direction.x !== 1) {
                    this.nextDirection = { x: -1, y: 0 };
                }
                break;
            case 'right':
                if (this.direction.x !== -1) {
                    this.nextDirection = { x: 1, y: 0 };
                }
                break;
        }
    }
    
    // ========== 手势滑动控制 ==========
    initSwipeControls() {
        const gameArea = document.getElementById('gameScreen');
        
        gameArea.addEventListener('touchstart', (e) => {
            this.touchStartX = e.touches[0].clientX;
            this.touchStartY = e.touches[0].clientY;
        }, { passive: true });
        
        gameArea.addEventListener('touchend', (e) => {
            if (!this.game.isRunning) return;
            
            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            
            const dx = touchEndX - this.touchStartX;
            const dy = touchEndY - this.touchStartY;
            
            // 判断滑动方向（取绝对值较大的方向）
            if (Math.abs(dx) > Math.abs(dy)) {
                // 水平滑动
                if (Math.abs(dx) > 30) { // 最小滑动距离
                    if (dx > 0 && this.direction.x !== -1) {
                        this.nextDirection = { x: 1, y: 0 };
                    } else if (dx < 0 && this.direction.x !== 1) {
                        this.nextDirection = { x: -1, y: 0 };
                    }
                }
            } else {
                // 垂直滑动
                if (Math.abs(dy) > 30) {
                    if (dy > 0 && this.direction.y !== -1) {
                        this.nextDirection = { x: 0, y: 1 };
                    } else if (dy < 0 && this.direction.y !== 1) {
                        this.nextDirection = { x: 0, y: -1 };
                    }
                }
            }
            
            effects.vibrate([10]);
        }, { passive: true });
    }
    
    // ========== 更新方向 ==========
    updateDirection() {
        this.direction = { ...this.nextDirection };
        return this.direction;
    }
    
    // ========== 重置方向 ==========
    resetDirection() {
        this.direction = { x: 1, y: 0 };
        this.nextDirection = { x: 1, y: 0 };
    }
    
    // ========== 获取当前方向 ==========
    getDirection() {
        return this.direction;
    }
}
