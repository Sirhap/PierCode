/**
 * 特效模块
 * 负责粒子效果、音效等视觉和听觉效果
 */

class EffectsManager {
    constructor() {
        this.particles = [];
        this.canvas = null;
        this.ctx = null;
        this.settings = storage.getSettings();
        
        // 音效（使用 Web Audio API 生成，无需外部文件）
        this.audioContext = null;
        this.initAudio();
    }
    
    initAudio() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('Web Audio API 不支持');
        }
    }
    
    setCanvas(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
    }
    
    // ========== 粒子效果 ==========
    createParticle(x, y, color, type = 'burst') {
        const particle = {
            x: x,
            y: y,
            color: color,
            vx: (Math.random() - 0.5) * 8,
            vy: (Math.random() - 0.5) * 8,
            life: 1,
            decay: 0.02 + Math.random() * 0.02,
            size: 2 + Math.random() * 4,
            type: type
        };
        this.particles.push(particle);
    }
    
    createExplosion(x, y, color, count = 15) {
        for (let i = 0; i < count; i++) {
            this.createParticle(x, y, color, 'burst');
        }
    }
    
    createTrail(x, y, color) {
        if (Math.random() > 0.5) return; // 减少粒子数量
        const particle = {
            x: x,
            y: y,
            color: color,
            vx: (Math.random() - 0.5) * 2,
            vy: (Math.random() - 0.5) * 2,
            life: 1,
            decay: 0.05,
            size: 1 + Math.random() * 2,
            type: 'trail'
        };
        this.particles.push(particle);
    }
    
    updateParticles() {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx;
            p.y += p.vy;
            p.life -= p.decay;
            p.vy += 0.1; // 重力效果
            
            if (p.life <= 0) {
                this.particles.splice(i, 1);
            }
        }
    }
    
    drawParticles() {
        if (!this.ctx) return;
        
        this.particles.forEach(p => {
            this.ctx.save();
            this.ctx.globalAlpha = p.life;
            this.ctx.fillStyle = p.color;
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.restore();
        });
    }
    
    clearParticles() {
        this.particles = [];
    }
    
    // ========== 音效系统 ==========
    playSound(type) {
        if (!this.settings.sound || !this.audioContext) return;
        
        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);
        
        switch (type) {
            case 'eat':
                oscillator.frequency.setValueAtTime(523.25, this.audioContext.currentTime); // C5
                oscillator.frequency.exponentialRampToValueAtTime(1046.5, this.audioContext.currentTime + 0.1); // C6
                gainNode.gain.setValueAtTime(0.3, this.audioContext.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);
                oscillator.start(this.audioContext.currentTime);
                oscillator.stop(this.audioContext.currentTime + 0.1);
                break;
                
            case 'gameOver':
                oscillator.frequency.setValueAtTime(392, this.audioContext.currentTime); // G4
                oscillator.frequency.exponentialRampToValueAtTime(196, this.audioContext.currentTime + 0.5); // G3
                gainNode.gain.setValueAtTime(0.3, this.audioContext.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.5);
                oscillator.start(this.audioContext.currentTime);
                oscillator.stop(this.audioContext.currentTime + 0.5);
                break;
                
            case 'start':
                oscillator.frequency.setValueAtTime(261.63, this.audioContext.currentTime); // C4
                oscillator.frequency.setValueAtTime(329.63, this.audioContext.currentTime + 0.1); // E4
                oscillator.frequency.setValueAtTime(392, this.audioContext.currentTime + 0.2); // G4
                oscillator.frequency.setValueAtTime(523.25, this.audioContext.currentTime + 0.3); // C5
                gainNode.gain.setValueAtTime(0.2, this.audioContext.currentTime);
                gainNode.gain.linearRampToValueAtTime(0.01, this.audioContext.currentTime + 0.4);
                oscillator.start(this.audioContext.currentTime);
                oscillator.stop(this.audioContext.currentTime + 0.4);
                break;
                
            case 'pause':
                oscillator.frequency.setValueAtTime(440, this.audioContext.currentTime); // A4
                gainNode.gain.setValueAtTime(0.2, this.audioContext.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.15);
                oscillator.start(this.audioContext.currentTime);
                oscillator.stop(this.audioContext.currentTime + 0.15);
                break;
                
            case 'unlock':
                oscillator.frequency.setValueAtTime(523.25, this.audioContext.currentTime);
                oscillator.frequency.setValueAtTime(659.25, this.audioContext.currentTime + 0.1);
                oscillator.frequency.setValueAtTime(783.99, this.audioContext.currentTime + 0.2);
                oscillator.frequency.setValueAtTime(1046.5, this.audioContext.currentTime + 0.3);
                gainNode.gain.setValueAtTime(0.2, this.audioContext.currentTime);
                gainNode.gain.linearRampToValueAtTime(0.01, this.audioContext.currentTime + 0.4);
                oscillator.start(this.audioContext.currentTime);
                oscillator.stop(this.audioContext.currentTime + 0.4);
                break;
        }
    }
    
    // ========== 震动反馈 ==========
    vibrate(pattern) {
        if (!this.settings.vibration || !navigator.vibrate) return;
        navigator.vibrate(pattern);
    }
    
    vibrateEat() {
        this.vibrate([10]);
    }
    
    vibrateGameOver() {
        this.vibrate([50, 50, 50]);
    }
    
    vibrateButton() {
        this.vibrate([5]);
    }
    
    // ========== 屏幕闪烁效果 ==========
    flashScreen(color = 'rgba(255, 255, 255, 0.3)') {
        const flash = document.createElement('div');
        flash.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: ${color};
            pointer-events: none;
            z-index: 100;
            animation: flashAnim 0.3s ease-out;
        `;
        document.body.appendChild(flash);
        
        // 添加动画样式
        if (!document.getElementById('flashStyle')) {
            const style = document.createElement('style');
            style.id = 'flashStyle';
            style.textContent = `
                @keyframes flashAnim {
                    0% { opacity: 1; }
                    100% { opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }
        
        setTimeout(() => flash.remove(), 300);
    }
    
    // ========== 更新设置 ==========
    updateSettings() {
        this.settings = storage.getSettings();
    }
}

// 创建全局实例
const effects = new EffectsManager();
