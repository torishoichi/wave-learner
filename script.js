// ---------- Application State ----------
const state = {
    mode: 'fundamental', // 'fundamental', 'reflection', 'aircolumn', 'helmholtz'
    params: {
        amp: 1.0,
        freq: 440,
        speed: 340,
        time: 0, // Master simulation time
        
        // Mode specific params
        reflectionBoundary: 'fixed', // 'fixed', 'free'
        pipeType: 'open', // 'open', 'closed'
        pipeLength: 0.5, // meters
        cavityVol: 0.001, // m^3
        neckArea: 0.0005, // m^2
        neckLength: 0.05, // m
        
        // Vocal Tract / Concatenated Tube params
        tractSections: 4,
        tractAreas: [1.0, 1.0, 1.0, 1.0], // Default cross sections cm^2
        tractLength: 17.0, // Default length in cm
        f0: 120, // Glottal source fundamental frequency
        
        // Derived or selected visualization params
        viewType: 'y-x', // 'transverse', 'longitudinal', 'y-x', 'y-t'
        reflectionView: 'super', // 'super', 'parts'
        n: 1, // harmonic number
        pipeDisplay: 'pressure' // 'pressure', 'displacement'
    },
    audio: {
        ctx: null,
        oscillator: null,
        gainNode: null,
        scriptNode: null,
        isPlaying: false,
        volume: 0.5
    },
    animationFrameId: null,
    isPaused: false,
    playbackSpeed: 1.0,
    vocalTract: null // will be initialized holding pPlus and pMinus
};

// ---------- DOM Elements ----------
const canvas = document.getElementById('sim-canvas');
const ctx = canvas.getContext('2d');

const navItems = document.querySelectorAll('.nav-links li');
const titleEl = document.getElementById('mode-title');
const subtitleEl = document.getElementById('mode-subtitle');
const formulaEl = document.getElementById('formula-display');
const controlsGrid = document.getElementById('controls-grid');

const sliderAmp = document.getElementById('slider-amp');
const sliderFreq = document.getElementById('slider-freq');
const sliderSpeed = document.getElementById('slider-speed');
const valAmp = document.getElementById('val-amp');
const valFreq = document.getElementById('val-freq');
const valSpeed = document.getElementById('val-speed');

const btnToggleSound = document.getElementById('btn-toggle-sound');
const soundIcon = document.getElementById('sound-icon');
const soundText = document.getElementById('sound-text');
const statusIndicator = document.querySelector('.status-indicator');

// Playback controls
const btnPlayPause = document.getElementById('btn-play-pause');
const btnStepForward = document.getElementById('btn-step-forward');
const btnStepBack = document.getElementById('btn-step-back');
const sliderSpeedMult = document.getElementById('slider-speed-mult');
const valSpeedMult = document.getElementById('val-speed-mult');
const calcGrid = document.getElementById('calc-grid');

// ---------- Initialization ----------
function init() {
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    // Bind global controls
    sliderAmp.addEventListener('input', (e) => updateParam('amp', parseFloat(e.target.value), valAmp));
    sliderFreq.addEventListener('input', (e) => updateParam('freq', parseFloat(e.target.value), valFreq));
    sliderSpeed.addEventListener('input', (e) => updateParam('speed', parseFloat(e.target.value), valSpeed));
    
    // Bind Navigation
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            navItems.forEach(n => n.classList.remove('active'));
            e.currentTarget.classList.add('active');
            setMode(e.currentTarget.dataset.mode);
        });
    });

    // Audio binding
    btnToggleSound.addEventListener('click', toggleAudio);

    // Playback controls
    btnPlayPause.addEventListener('click', togglePause);
    btnStepForward.addEventListener('click', () => stepFrame(1));
    btnStepBack.addEventListener('click', () => stepFrame(-1));
    sliderSpeedMult.addEventListener('input', (e) => {
        state.playbackSpeed = parseFloat(e.target.value);
        valSpeedMult.textContent = '×' + state.playbackSpeed.toFixed(state.playbackSpeed % 1 === 0 ? 1 : 2);
    });



    // Volume slider binding
    const sliderVolume = document.getElementById('slider-volume');
    const valVolume = document.getElementById('val-volume');
    sliderVolume.addEventListener('input', (e) => {
        const vol = parseInt(e.target.value);
        state.audio.volume = vol / 100;
        valVolume.innerText = vol;
        if (state.audio.isPlaying && state.audio.gainNode) {
            state.audio.gainNode.gain.setTargetAtTime(state.audio.volume, state.audio.ctx.currentTime, 0.05);
        }
    });

    // Initial render setup
    buildDynamicControls();
    updateFormulaDisplay();
    updateCalcPanel();
    startSimulation();
}

function resizeCanvas() {
    // Make canvas responsive to its container
    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
}

// ---------- Logic / Updates ----------
function updateParam(key, val, displayEl) {
    state.params[key] = val;
    if (displayEl) displayEl.innerText = val.toFixed(key === 'amp' ? 1 : 0);
    
    // Update audio if playing
    if (state.audio.isPlaying && state.audio.oscillator) {
        state.audio.oscillator.frequency.setTargetAtTime(calcCurrentFrequency(), state.audio.ctx.currentTime, 0.1);
    }
    
    // Some params depend on others, update derived formulas
    updateFormulaDisplay();
    updateCalcPanel();
}

function calcCurrentFrequency() {
    // For fundamental mode and reflection, frequency is the slider
    if (state.mode === 'fundamental' || state.mode === 'reflection') {
        return state.params.freq;
    } 
    // For air columns, f = n*v/(2L) or (2n-1)v/(4L) depending on pipe type
    else if (state.mode === 'aircolumn') {
        const v = state.params.speed;
        const L = state.params.pipeLength;
        if (state.params.pipeType === 'open') {
            return (state.params.n * v) / (2 * L);
        } else {
            const m = 2 * state.params.n - 1;
            return (m * v) / (4 * L);
        }
    }
    // For Helmholtz, f = (v/(2*pi)) * sqrt(A/(V*L))
    else if (state.mode === 'helmholtz') {
        const v = state.params.speed;
        const A = state.params.neckArea;
        const V = state.params.cavityVol;
        const L_eff = state.params.neckLength; // should actually be L + 0.6r etc, simplifying for now
        return (v / (2 * Math.PI)) * Math.sqrt(A / (V * L_eff));
    }
    // For Vocal Tract, compute first formant F1 based on tube geometry
    else if (state.mode === 'vocaltract') {
        return findF1();
    }
    return 440;
}

// --- New acoustic calculation functions ---
function getTractGain(f, areas, L_total, c) {
    const k = 2 * Math.PI * f / c;
    const sections = areas.length;
    const l = (L_total / 100) / sections;
    
    let p_re = 0, p_im = 0; // p_out = 0 (open lips)
    let U_re = 1, U_im = 0; // U_out = 1
    
    for (let i = sections - 1; i >= 0; i--) {
        const A = areas[i];
        const Z_c = 1.0 / A;
        
        const cos_kl = Math.cos(k * l);
        const sin_kl = Math.sin(k * l);
        
        const next_p_re = p_re * cos_kl - U_im * Z_c * sin_kl;
        const next_p_im = p_im * cos_kl + U_re * Z_c * sin_kl;
        
        const next_U_re = -(p_im / Z_c) * sin_kl + U_re * cos_kl;
        const next_U_im = (p_re / Z_c) * sin_kl + U_im * cos_kl;
        
        p_re = next_p_re;
        p_im = next_p_im;
        U_re = next_U_re;
        U_im = next_U_im;
    }
    
    const U_in_mag = Math.sqrt(U_re*U_re + U_im*U_im);
    return 1.0 / (U_in_mag + 1e-10);
}

// Cache F1 to avoid calculating it on every frame unless parameters changed
let lastF1Params = "";
let cachedF1 = 500;
function findF1() {
    const paramsStr = `${state.params.tractLength}_${state.params.speed}_${state.params.tractAreas.join(',')}`;
    if (paramsStr === lastF1Params) return cachedF1;
    
    let maxGain = -1;
    let bestF = 500;
    for (let f = 100; f <= 1500; f += 2) {
        const gain = getTractGain(f, state.params.tractAreas, state.params.tractLength, state.params.speed);
        if (gain > maxGain) {
            maxGain = gain;
            bestF = f;
        }
    }
    
    lastF1Params = paramsStr;
    cachedF1 = bestF;
    return bestF;
}

function setMode(newMode) {
    state.mode = newMode;
    switch(newMode) {
        case 'fundamental':
            titleEl.textContent = '波の基本とグラフ';
            subtitleEl.textContent = '縦波・横波の視覚化と、y-x / y-t グラフでの正弦波の理解';
            break;
        case 'reflection':
            titleEl.textContent = '反射と定常波';
            subtitleEl.textContent = '固定端反射・自由端反射による合成波（定常波）の形成';
            break;
        case 'aircolumn':
            titleEl.textContent = '気柱 (開管・閉管)';
            subtitleEl.textContent = '開管および閉管での管内の圧力波と定常波（音の共鳴）';
            break;
        case 'helmholtz':
            titleEl.textContent = 'ヘルムホルツ共鳴腔';
            subtitleEl.textContent = '体積、首の長さ・面積に基づく共鳴周波数の計算と音響モデル';
            // In Helmholtz, general frequency slider isn't the driver, we calculate freq from dims.
            break;
        case 'vocaltract':
            titleEl.textContent = '連結管モデル (声道)';
            subtitleEl.textContent = '断面積の異なる管の境界における波の反射・透過による共鳴の形成';
            break;
    }
    buildDynamicControls();
    updateFormulaDisplay();
    updateCalcPanel();
    
    // If playing, immediately update audio to new formula target
    if (state.audio.isPlaying) {
        state.audio.oscillator.frequency.setTargetAtTime(calcCurrentFrequency(), state.audio.ctx.currentTime, 0.1);
    }
}

// Builds the specific knobs depending on current mode
function buildDynamicControls() {
    // Clear out any old dynamic properties
    const toRemove = controlsGrid.querySelectorAll('.dynamic-ctrl');
    toRemove.forEach(el => el.remove());

    // Basic Frequency slider is confusing in AirColumn/Helmholtz since freq is DERIVED from length/volume.
    // So we'll disable/hide standard freq slider for those modes.
    const freqBlock = document.getElementById('slider-freq').parentElement;
    if (state.mode === 'fundamental' || state.mode === 'reflection') {
        freqBlock.style.display = 'flex';
    } else {
        freqBlock.style.display = 'none';
    }
    
    if (state.mode === 'fundamental') {
        const html = `
            <div class="control-block dynamic-ctrl" style="grid-column: span 2;">
                <label>表示モード (View Mode)</label>
                <div class="radio-group" id="radio-fundamental-view">
                    <div class="radio-btn ${state.params.viewType === 'y-x' ? 'active' : ''}" data-val="y-x">y-x グラフ</div>
                    <div class="radio-btn ${state.params.viewType === 'y-t' ? 'active' : ''}" data-val="y-t">y-t グラフ</div>
                    <div class="radio-btn ${state.params.viewType === 'transverse' ? 'active' : ''}" data-val="transverse">横波 (粒子)</div>
                    <div class="radio-btn ${state.params.viewType === 'longitudinal' ? 'active' : ''}" data-val="longitudinal">縦波 (粒子)</div>
                </div>
            </div>
        `;
        controlsGrid.insertAdjacentHTML('beforeend', html);
        
        document.querySelectorAll('#radio-fundamental-view .radio-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('#radio-fundamental-view .radio-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                state.params.viewType = e.target.dataset.val;
            });
        });
    } else if (state.mode === 'reflection') {
        const html = `
            <div class="control-block dynamic-ctrl" style="grid-column: span 2;">
                <label>境界条件 (Boundary Condition)</label>
                <div class="radio-group" id="radio-reflection-type">
                    <div class="radio-btn ${state.params.reflectionBoundary === 'fixed' ? 'active' : ''}" data-val="fixed">固定端反射 (Fixed End)</div>
                    <div class="radio-btn ${state.params.reflectionBoundary === 'free' ? 'active' : ''}" data-val="free">自由端反射 (Free End)</div>
                </div>
            </div>
            <div class="control-block dynamic-ctrl" style="grid-column: span 2;">
                <label>波の表示 (Wave Display)</label>
                <div class="radio-group" id="radio-reflection-view">
                    <div class="radio-btn ${state.params.reflectionView === 'super' ? 'active' : ''}" data-val="super">合成波 (Superposition)</div>
                    <div class="radio-btn ${state.params.reflectionView === 'parts' ? 'active' : ''}" data-val="parts">入射波+反射波 (Components)</div>
                </div>
            </div>
        `;
        controlsGrid.insertAdjacentHTML('beforeend', html);
        
        document.querySelectorAll('#radio-reflection-type .radio-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('#radio-reflection-type .radio-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                state.params.reflectionBoundary = e.target.dataset.val;
                updateFormulaDisplay();
            });
        });

        document.querySelectorAll('#radio-reflection-view .radio-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('#radio-reflection-view .radio-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                state.params.reflectionView = e.target.dataset.val;
            });
        });
    } else if (state.mode === 'aircolumn') {
        const html = `
            <div class="control-block dynamic-ctrl" style="grid-column: span 2;">
                <label>管の種類 (Pipe Type)</label>
                <div class="radio-group" id="radio-aircolumn-type">
                    <div class="radio-btn ${state.params.pipeType === 'open' ? 'active' : ''}" data-val="open">開管 (Open Pipe)</div>
                    <div class="radio-btn ${state.params.pipeType === 'closed' ? 'active' : ''}" data-val="closed">閉管 (Closed Pipe)</div>
                </div>
            </div>
            <div class="control-block dynamic-ctrl" style="grid-column: span 2;">
                <label>波の表示 (Wave Display)</label>
                <div class="radio-group" id="radio-aircolumn-view">
                    <div class="radio-btn ${state.params.pipeDisplay === 'pressure' ? 'active' : ''}" data-val="pressure">圧力変化 (Pressure)</div>
                    <div class="radio-btn ${state.params.pipeDisplay === 'displacement' ? 'active' : ''}" data-val="displacement">変位 (Displacement)</div>
                </div>
            </div>
            <div class="control-block dynamic-ctrl">
                <div class="label-row">
                    <label>管の長さ L (m)</label>
                    <span class="val-badge"><span id="val-pipelength">${state.params.pipeLength.toFixed(2)}</span></span>
                </div>
                <input type="range" id="slider-pipelength" class="custom-slider" min="0.1" max="2.0" step="0.05" value="${state.params.pipeLength}">
            </div>
            <div class="control-block dynamic-ctrl">
                <div class="label-row">
                    <label>倍音 n (Harmonic)</label>
                    <span class="val-badge"><span id="val-harmonic">${state.params.n}</span></span>
                </div>
                <input type="range" id="slider-harmonic" class="custom-slider" min="1" max="5" step="1" value="${state.params.n}">
            </div>
        `;
        controlsGrid.insertAdjacentHTML('beforeend', html);
        
        document.getElementById('slider-pipelength').addEventListener('input', (e) => {
            updateParam('pipeLength', parseFloat(e.target.value), document.getElementById('val-pipelength'));
        });
        document.getElementById('slider-harmonic').addEventListener('input', (e) => {
            updateParam('n', parseInt(e.target.value), document.getElementById('val-harmonic'));
        });
        document.querySelectorAll('#radio-aircolumn-type .radio-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('#radio-aircolumn-type .radio-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                state.params.pipeType = e.target.dataset.val;
                updateFormulaDisplay();
                if (state.audio.isPlaying) state.audio.oscillator.frequency.setTargetAtTime(calcCurrentFrequency(), state.audio.ctx.currentTime, 0.1);
            });
        });
        document.querySelectorAll('#radio-aircolumn-view .radio-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('#radio-aircolumn-view .radio-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                state.params.pipeDisplay = e.target.dataset.val;
            });
        });
    } else if (state.mode === 'helmholtz') {
        const html = `
            <div class="control-block dynamic-ctrl" style="grid-column: span 2;">
                <div class="label-row">
                    <label>空洞の体積 V (L)</label>
                    <span class="val-badge"><span id="val-cavityVol">${(state.params.cavityVol * 1000).toFixed(1)}</span></span>
                </div>
                <input type="range" id="slider-cavityVol" class="custom-slider" min="0.0001" max="0.005" step="0.0001" value="${state.params.cavityVol}">
            </div>
            <div class="control-block dynamic-ctrl">
                <div class="label-row">
                    <label>首の面積 A (cm²)</label>
                    <span class="val-badge"><span id="val-neckArea">${(state.params.neckArea * 10000).toFixed(1)}</span></span>
                </div>
                <input type="range" id="slider-neckArea" class="custom-slider" min="0.00005" max="0.002" step="0.00005" value="${state.params.neckArea}">
            </div>
            <div class="control-block dynamic-ctrl">
                <div class="label-row">
                    <label>首の長さ L (cm)</label>
                    <span class="val-badge"><span id="val-neckLength">${(state.params.neckLength * 100).toFixed(1)}</span></span>
                </div>
                <input type="range" id="slider-neckLength" class="custom-slider" min="0.01" max="0.2" step="0.01" value="${state.params.neckLength}">
            </div>
        `;
        controlsGrid.insertAdjacentHTML('beforeend', html);
        
        document.getElementById('slider-cavityVol').addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            updateParam('cavityVol', val, null);
            document.getElementById('val-cavityVol').innerText = (val * 1000).toFixed(1);
        });
        document.getElementById('slider-neckArea').addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            updateParam('neckArea', val, null);
            document.getElementById('val-neckArea').innerText = (val * 10000).toFixed(1);
        });
        document.getElementById('slider-neckLength').addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            updateParam('neckLength', val, null);
            document.getElementById('val-neckLength').innerText = (val * 100).toFixed(1);
        });
    } else if (state.mode === 'vocaltract') {
        let slidersHtml = '';
        for (let i = 0; i < state.params.tractSections; i++) {
            slidersHtml += `
                <div class="control-block dynamic-ctrl" style="grid-column: span 1;">
                    <div class="label-row">
                        <label>管 ${i+1} 面積 (cm²)</label>
                        <span class="val-badge"><span id="val-tractArea-${i}">${state.params.tractAreas[i].toFixed(1)}</span></span>
                    </div>
                    <input type="range" id="slider-tractArea-${i}" class="custom-slider" min="0.1" max="10.0" step="0.1" value="${state.params.tractAreas[i]}" data-idx="${i}">
                </div>
            `;
        }
        const html = `
            <div class="control-block dynamic-ctrl" style="grid-column: span 2;">
                <label>母音プリセット (Vowels)</label>
                <div class="radio-group" id="radio-vowels">
                    <div class="radio-btn" data-vowel="a">ア [a]</div>
                    <div class="radio-btn" data-vowel="i">イ [i]</div>
                    <div class="radio-btn" data-vowel="u">ウ [u]</div>
                    <div class="radio-btn" data-vowel="e">エ [e]</div>
                    <div class="radio-btn" data-vowel="o">オ [o]</div>
                </div>
            </div>
            <div class="control-block dynamic-ctrl" style="grid-column: span 1;">
                <div class="label-row">
                    <label>声道長 L (cm)</label>
                    <span class="val-badge"><span id="val-tractLength">${state.params.tractLength.toFixed(1)}</span></span>
                </div>
                <input type="range" id="slider-tractLength" class="custom-slider" min="10.0" max="25.0" step="0.5" value="${state.params.tractLength}">
            </div>
            <div class="control-block dynamic-ctrl" style="grid-column: span 1;">
                <div class="label-row">
                    <label>基本周波数 F0 (Hz)</label>
                    <span class="val-badge"><span id="val-f0">${state.params.f0.toFixed(0)}</span></span>
                </div>
                <input type="range" id="slider-f0" class="custom-slider" min="50" max="400" step="5" value="${state.params.f0}">
            </div>
            ${slidersHtml}
        `;
        controlsGrid.insertAdjacentHTML('beforeend', html);
        
        document.querySelectorAll('#radio-vowels .radio-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const vowel = e.target.dataset.vowel;
                const presets = {
                    'a': [1.0, 2.0, 6.0, 10.0],
                    'i': [9.0, 5.0, 1.0, 0.5],
                    'u': [3.0, 7.0, 2.0, 0.5],
                    'e': [4.0, 3.0, 5.0, 4.0],
                    'o': [2.0, 7.0, 3.0, 1.0]
                };
                if (presets[vowel]) {
                    document.querySelectorAll('#radio-vowels .radio-btn').forEach(b => b.classList.remove('active'));
                    e.target.classList.add('active');
                    
                    for(let i=0; i<state.params.tractSections; i++) {
                        if (i < presets[vowel].length) {
                            state.params.tractAreas[i] = presets[vowel][i];
                            const slider = document.getElementById(`slider-tractArea-${i}`);
                            const valDisplay = document.getElementById(`val-tractArea-${i}`);
                            if(slider) slider.value = presets[vowel][i];
                            if(valDisplay) valDisplay.innerText = presets[vowel][i].toFixed(1);
                        }
                    }
                    updateFormulaDisplay();
                    updateCalcPanel();
                }
            });
        });
        
        document.getElementById('slider-tractLength').addEventListener('input', (e) => {
            state.params.tractLength = parseFloat(e.target.value);
            document.getElementById('val-tractLength').innerText = state.params.tractLength.toFixed(1);
            updateFormulaDisplay();
            updateCalcPanel();
        });
        
        document.getElementById('slider-f0').addEventListener('input', (e) => {
            state.params.f0 = parseFloat(e.target.value);
            document.getElementById('val-f0').innerText = state.params.f0.toFixed(0);
            updateFormulaDisplay();
            updateCalcPanel();
        });
        
        for (let i = 0; i < state.params.tractSections; i++) {
            document.getElementById(`slider-tractArea-${i}`).addEventListener('input', (e) => {
                const idx = parseInt(e.target.dataset.idx);
                state.params.tractAreas[idx] = parseFloat(e.target.value);
                document.getElementById(`val-tractArea-${idx}`).innerText = state.params.tractAreas[idx].toFixed(1);
                updateFormulaDisplay();
                updateCalcPanel();
            });
        }
    }
}

function updateFormulaDisplay() {
    // Updates MathJax math content string
    let mathStr = "";
    
    if (state.mode === 'fundamental') {
        mathStr = `$$ y(x,t) = A \\sin \\left( 2\\pi ft - \\frac{2\\pi x}{\\lambda} \\right) $$`;
    } else if (state.mode === 'reflection') {
        mathStr = `$$ y(x,t) = 2A \\sin(kx) \\cos(\\omega t) \\quad \\text{(定常波)} $$`;
    } else if (state.mode === 'aircolumn') {
        if (state.params.pipeType === 'open') {
             mathStr = `$$ f_n = \\frac{nv}{2L} \\implies f_{${state.params.n}} = \\frac{${state.params.n} \\times ${state.params.speed.toFixed(0)}}{2 \\times ${state.params.pipeLength.toFixed(2)}} = ${calcCurrentFrequency().toFixed(1)}\\text{ Hz} $$`;
        } else {
             const m = 2 * state.params.n - 1;
             mathStr = `$$ f_m = \\frac{mv}{4L} \\implies f_{${m}} = \\frac{${m} \\times ${state.params.speed.toFixed(0)}}{4 \\times ${state.params.pipeLength.toFixed(2)}} = ${calcCurrentFrequency().toFixed(1)}\\text{ Hz} $$`;
        }
    } else if (state.mode === 'helmholtz') {
        mathStr = `$$ f = \\frac{v}{2\\pi} \\sqrt{\\frac{A}{VL}} \\approx ${calcCurrentFrequency().toFixed(1)}\\text{ Hz} $$`;
    } else if (state.mode === 'vocaltract') {
        mathStr = `$$ r = \\frac{A_1 - A_2}{A_1 + A_2} \\quad \\text{(反射係数)} $$`;
    }

    formulaEl.innerHTML = mathStr;
    if (window.MathJax) {
        MathJax.typesetPromise([formulaEl]).catch((err) => console.log(err.message));
    }


}

// ---------- Real-time Calculation Panel ----------
function updateCalcPanel() {
    const f = calcCurrentFrequency();
    const v = state.params.speed;
    const lambda = v / f;
    const T = 1 / f;
    const k = (2 * Math.PI) / lambda;
    const omega = 2 * Math.PI * f;
    
    let items = [];
    
    if (state.mode === 'fundamental' || state.mode === 'reflection') {
        items = [
            { symbol: 'λ', label: '波長', value: lambda >= 1 ? lambda.toFixed(3) : (lambda * 100).toFixed(1), unit: lambda >= 1 ? 'm' : 'cm' },
            { symbol: 'T', label: '周期', value: T >= 0.001 ? (T * 1000).toFixed(2) : (T * 1e6).toFixed(1), unit: T >= 0.001 ? 'ms' : 'μs' },
            { symbol: 'f', label: '周波数', value: f.toFixed(1), unit: 'Hz' },
            { symbol: 'k', label: '波数', value: k.toFixed(2), unit: 'rad/m' },
            { symbol: 'ω', label: '角振動数', value: omega.toFixed(1), unit: 'rad/s' },
            { symbol: 'v', label: '波の速さ', value: v.toFixed(0), unit: 'm/s' },
        ];
    } else if (state.mode === 'aircolumn') {
        const L = state.params.pipeLength;
        const lambdaPipe = state.params.pipeType === 'open' ? (2 * L / state.params.n) : (4 * L / (2 * state.params.n - 1));
        items = [
            { symbol: 'f', label: '共鳴周波数', value: f.toFixed(1), unit: 'Hz' },
            { symbol: 'L', label: '管の長さ', value: (L * 100).toFixed(1), unit: 'cm' },
            { symbol: 'λ', label: '管内波長', value: (lambdaPipe * 100).toFixed(1), unit: 'cm' },
            { symbol: 'n', label: '倍音次数', value: state.params.n.toString(), unit: '' },
            { symbol: 'v', label: '音速', value: v.toFixed(0), unit: 'm/s' },
        ];
    } else if (state.mode === 'helmholtz') {
        const V = state.params.cavityVol;
        const A = state.params.neckArea;
        const Ln = state.params.neckLength;
        items = [
            { symbol: 'f₀', label: '共鳴周波数', value: f.toFixed(1), unit: 'Hz' },
            { symbol: 'V', label: '空洞体積', value: (V * 1e6).toFixed(0), unit: 'cm³' },
            { symbol: 'A', label: '首断面積', value: (A * 1e4).toFixed(2), unit: 'cm²' },
            { symbol: 'L', label: '首の長さ', value: (Ln * 100).toFixed(1), unit: 'cm' },
            { symbol: 'v', label: '音速', value: v.toFixed(0), unit: 'm/s' },
        ];
    } else if (state.mode === 'vocaltract') {
        let rs = [];
        for (let i=0; i < state.params.tractSections - 1; i++) {
            const a1 = state.params.tractAreas[i];
            const a2 = state.params.tractAreas[i+1];
            const r = (a1 + a2) === 0 ? 0 : (a1 - a2) / (a1 + a2);
            rs.push(r.toFixed(2));
        }
        items = [
            { symbol: 'F₀', label: '基本周波数', value: state.params.f0.toFixed(0), unit: 'Hz' },
            { symbol: 'F₁', label: '第1フォルマント', value: f.toFixed(1), unit: 'Hz' },
            { symbol: 'L', label: '声道長', value: state.params.tractLength.toFixed(1), unit: 'cm' },
            { symbol: 'r₁', label: '反射(1-2)', value: rs[0] || "0", unit: '' },
            { symbol: 'r₂', label: '反射(2-3)', value: rs[1] || "0", unit: '' },
            { symbol: 'r₃', label: '反射(3-4)', value: rs[2] || "0", unit: '' },
        ];
    }
    
    // Build HTML
    const prevValues = {};
    calcGrid.querySelectorAll('.calc-item').forEach(el => {
        prevValues[el.dataset.key] = el.querySelector('.calc-value').textContent;
    });
    
    calcGrid.innerHTML = items.map(item => {
        const valStr = item.value + (item.unit ? ' ' : '');
        const changed = prevValues[item.symbol] !== undefined && prevValues[item.symbol] !== valStr;
        return `<div class="calc-item" data-key="${item.symbol}">
            <span class="calc-label"><span class="calc-symbol">${item.symbol}</span>${item.label}</span>
            <span class="calc-value${changed ? ' flash' : ''}">${valStr}<span class="calc-unit">${item.unit}</span></span>
        </div>`;
    }).join('');
    
    // Remove flash class after animation
    setTimeout(() => {
        calcGrid.querySelectorAll('.calc-value.flash').forEach(el => el.classList.remove('flash'));
    }, 400);
}

// ---------- Audio Synthesis Web Audio API ----------
async function toggleAudio() {
    if (!state.audio.ctx) {
        // Initialize Web Audio API
        state.audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
        state.audio.gainNode = state.audio.ctx.createGain();
        state.audio.gainNode.gain.setValueAtTime(0, state.audio.ctx.currentTime);
        state.audio.gainNode.connect(state.audio.ctx.destination);
    }
    
    // Ensure context is running (browser autoplay policies)
    if (state.audio.ctx.state === 'suspended') {
        await state.audio.ctx.resume();
    }

    if (!state.audio.isPlaying) {
        if (state.mode === 'vocaltract') {
            const bufferSize = 1024;
            const createProcessor = state.audio.ctx.createScriptProcessor || state.audio.ctx.createJavaScriptNode;
            state.audio.scriptNode = createProcessor.call(state.audio.ctx, bufferSize, 1, 1);
            
            const sampleRate = state.audio.ctx.sampleRate;
            const sections = state.params.tractSections;
            const c = state.params.speed; 
            
            // To support varying tract lengths up to 30cm dynamically,
            // we allocate a buffer large enough for max possible delay per section.
            // 30cm / 4 sections = 7.5cm/section. Max delay = 0.075 / 340 * 48000 = ~10.6 samples.
            // 64 is safely large enough.
            const MAX_SECTION_DELAY = 64;
            
            const plusBufs = Array.from({length: sections}, () => new Float32Array(MAX_SECTION_DELAY));
            const minusBufs = Array.from({length: sections}, () => new Float32Array(MAX_SECTION_DELAY));
            let ptr = 0;
            let phase = 0;
            
            state.audio.scriptNode.onaudioprocess = function(e) {
                const output = e.outputBuffer.getChannelData(0);
                const freq = state.params.f0; 
                const phaseInc = 2 * Math.PI * freq / sampleRate;
                
                const r = new Float32Array(sections - 1);
                for (let i=0; i<sections-1; i++) {
                    const A1 = state.params.tractAreas[i];
                    const A2 = state.params.tractAreas[i+1];
                    r[i] = (A1 + A2 === 0) ? 0 : (A1 - A2) / (A1 + A2);
                }
                
                // Calculate dynamic fractional delay
                const currentTractL = state.params.tractLength / 100; // m
                const actualDelay = (currentTractL / sections) / state.params.speed * sampleRate;
                let dInt = Math.floor(actualDelay);
                let dFrac = actualDelay - dInt;
                
                // Safety bound
                if (dInt < 1) dInt = 1;
                if (dInt >= MAX_SECTION_DELAY - 1) dInt = MAX_SECTION_DELAY - 2;
                
                for (let i = 0; i < bufferSize; i++) {
                    phase += phaseInc;
                    if(phase >= 2*Math.PI) phase -= 2*Math.PI;
                    
                    // Pseudo-glottal pulse (LF-like approximation): open slowly, close fast
                    const nPhase = phase / Math.PI; // 0 to 2
                    let source = 0;
                    if (nPhase < 1.0) {
                        source = 0.5 * (1.0 - Math.cos(nPhase * Math.PI)); // Gradual opening
                    } else {
                        source = Math.max(0, 1.0 - (nPhase - 1.0) * 5.0); // Fast closing snapping shut
                    }
                    source = (source - 0.5) * state.params.amp; // center around 0
                    
                    const pUp = new Float32Array(sections);
                    const pDown = new Float32Array(sections);
                    
                    // Fractional delay reading using linear interpolation
                    const readPtr1 = (ptr + dInt) % MAX_SECTION_DELAY;
                    const readPtr2 = (ptr + dInt + 1) % MAX_SECTION_DELAY;
                    
                    for(let s=0; s<sections; s++) {
                        const up1 = plusBufs[s][readPtr1];
                        const up2 = plusBufs[s][readPtr2];
                        pUp[s] = up1 * (1 - dFrac) + up2 * dFrac;
                        
                        const down1 = minusBufs[s][readPtr1];
                        const down2 = minusBufs[s][readPtr2];
                        pDown[s] = down1 * (1 - dFrac) + down2 * dFrac;
                    }
                    
                    // Boundary scatterings
                    const inPlus = source + 0.9 * pDown[0]; // Glottis reflection
                    const inMinus = -0.9 * pUp[sections-1]; // Lips reflection
                    
                    const scatteredPlus = new Float32Array(sections);
                    const scatteredMinus = new Float32Array(sections);
                    
                    scatteredPlus[0] = inPlus;
                    scatteredMinus[sections-1] = inMinus;
                    
                    for (let s = 0; s < sections - 1; s++) {
                        scatteredPlus[s+1] = (1 + r[s]) * pUp[s] - r[s] * pDown[s+1];
                        scatteredMinus[s] = r[s] * pUp[s] + (1 - r[s]) * pDown[s+1];
                    }
                    
                    // Attrition (simulate wall loss)
                    const attenuation = 0.999;
                    
                    // Retreat pointer
                    ptr = (ptr === 0) ? MAX_SECTION_DELAY - 1 : ptr - 1;
                    
                    for (let s=0; s<sections; s++) {
                        plusBufs[s][ptr] = scatteredPlus[s] * attenuation;
                        minusBufs[s][ptr] = scatteredMinus[s] * attenuation;
                    }
                    
                    output[i] = pUp[sections-1] * 0.5;
                }
            };
            
            state.audio.scriptNode.connect(state.audio.gainNode);
        } else {
            state.audio.oscillator = state.audio.ctx.createOscillator();
            state.audio.oscillator.type = 'sine';
            state.audio.oscillator.frequency.value = calcCurrentFrequency();
            state.audio.oscillator.connect(state.audio.gainNode);
            state.audio.oscillator.start();
        }
        
        // Envelope Attack (fade in to avoid click)
        state.audio.gainNode.gain.setTargetAtTime(state.audio.volume, state.audio.ctx.currentTime, 0.05);
        state.audio.isPlaying = true;
        
        // Update UI
        btnToggleSound.classList.add('active-play');
        btnToggleSound.classList.remove('primary');
        soundIcon.innerText = "🔊";
        soundText.innerText = "Stop Sound";
        statusIndicator.innerText = "Active";
        statusIndicator.classList.remove('off');
        statusIndicator.classList.add('on');
    } else {
        // Envelope Release (fade out to avoid click)
        state.audio.gainNode.gain.setTargetAtTime(0, state.audio.ctx.currentTime, 0.05);
        setTimeout(() => {
            if (state.audio.oscillator) {
                state.audio.oscillator.stop();
                state.audio.oscillator.disconnect();
                state.audio.oscillator = null;
            }
            if (state.audio.scriptNode) {
                state.audio.scriptNode.disconnect();
                state.audio.scriptNode = null;
            }
        }, 100); // Wait for fade out
        
        state.audio.isPlaying = false;
        
        // Update UI
        btnToggleSound.classList.remove('active-play');
        btnToggleSound.classList.add('primary');
        soundIcon.innerText = "🔇";
        soundText.innerText = "Play Sound";
        statusIndicator.innerText = "Off";
        statusIndicator.classList.remove('on');
        statusIndicator.classList.add('off');
    }
}

// ---------- Simulation Rendering Frame ----------
function togglePause() {
    state.isPaused = !state.isPaused;
    btnPlayPause.textContent = state.isPaused ? '▶' : '⏸';
    btnPlayPause.classList.toggle('paused', state.isPaused);
}

function stepFrame(dir) {
    if (!state.isPaused) togglePause();
    state.params.time += (1/60) * 5 * dir;
    renderFrame();
}

function startSimulation() {
    let lastTime = performance.now();
    function loop(now) {
        const dt = (now - lastTime) / 1000;
        lastTime = now;
        
        if (!state.isPaused) {
            state.params.time += dt * 5 * state.playbackSpeed;
        }
        
        renderFrame();
        state.animationFrameId = requestAnimationFrame(loop);
    }
    state.animationFrameId = requestAnimationFrame(loop);
}

function drawParticle(x, y, color) {
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
}

function drawDoubleArrow(x1, y1, x2, y2, label, color) {
    const headLen = 8;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const angle = Math.atan2(dy, dx);
    
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    
    // Line
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    
    // Arrowhead at start
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 + headLen * Math.cos(angle - Math.PI/6), y1 + headLen * Math.sin(angle - Math.PI/6));
    ctx.lineTo(x1 + headLen * Math.cos(angle + Math.PI/6), y1 + headLen * Math.sin(angle + Math.PI/6));
    ctx.closePath();
    ctx.fill();
    
    // Arrowhead at end
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI/6), y2 - headLen * Math.sin(angle - Math.PI/6));
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI/6), y2 - headLen * Math.sin(angle + Math.PI/6));
    ctx.closePath();
    ctx.fill();
    
    // Label
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    ctx.font = 'bold 14px Inter';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Offset label perpendicular to arrow for readability
    const perpX = -Math.sin(angle) * 16;
    const perpY = Math.cos(angle) * 16;
    ctx.fillText(label, midX + perpX, midY + perpY);
    ctx.restore();
}

function drawFundamental(w, h) {
    const amp = state.params.amp * (h / 4);

    // Map physical screen width to 4.0 meters
    const physicalLength = 4.0;
    const pixelsPerMeter = w / physicalLength;

    // Calculate wavelength based on actual speed and frequency: λ = v / f
    const lambda_phys = state.params.speed / state.params.freq;
    const lambda_vis = lambda_phys * pixelsPerMeter;
    const visualK = (2 * Math.PI) / lambda_vis;

    // Scale animation speed, with 440 Hz as a baseline "pleasing visual speed"
    const baseFreq = 440;
    const omega_vis = 2 * Math.PI * 0.4 * (state.params.freq / baseFreq);
    const t = state.params.time * omega_vis;

    if (state.params.viewType === 'y-x') {
        // --- y-x graph: snapshot of wave shape at current time ---
        // Draw axis labels
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '13px Inter';
        ctx.fillText('x →', w - 30, h / 2 + 20);
        ctx.fillText('y ↑', 10, 30);

        ctx.beginPath();
        for (let x = 0; x < w; x++) {
            const y = h / 2 + amp * Math.sin(visualK * x - t);
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 3;
        ctx.stroke();

        // Highlight one particle (red dot) moving up/down at x = w/2
        const pX = w / 2;
        const pY = h / 2 + amp * Math.sin(visualK * pX - t);
        drawParticle(pX, pY, '#ef4444');

        // Draw vertical guide line at pX
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.moveTo(pX, h / 2 - amp - 20);
        ctx.lineTo(pX, h / 2 + amp + 20);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);



        // --- Annotations: A (amplitude) ---
        const ampAnnotX = w * 0.15;
        const ampAnnotY = h / 2 + amp * Math.sin(visualK * ampAnnotX - t);
        // Draw from center line to wave
        ctx.beginPath();
        ctx.setLineDash([3, 3]);
        ctx.moveTo(ampAnnotX, h / 2);
        ctx.lineTo(ampAnnotX, h / 2 - amp);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
        drawDoubleArrow(ampAnnotX, h / 2, ampAnnotX, h / 2 - amp, 'A', '#ef4444');

    } else if (state.params.viewType === 'y-t') {
        // --- y-t graph: oscillation history of a single particle ---
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '13px Inter';
        ctx.fillText('t →', w - 30, h / 2 + 20);
        ctx.fillText('y ↑', 10, 30);

        ctx.beginPath();
        for (let x = 0; x < w; x++) {
            // x-axis represents time going to the right
            const tLocal = t - x * 0.02;
            const y = h / 2 + amp * Math.sin(-tLocal);
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 3;
        ctx.stroke();

        // --- Annotation: T (period) ---
        const periodPx = (2 * Math.PI) / 0.02;
        const tPhase = t % (2 * Math.PI);
        let firstPeakX = tPhase / 0.02;
        while (firstPeakX < 40) firstPeakX += periodPx;
        while (firstPeakX > w - periodPx - 40) firstPeakX -= periodPx;
        const secondPeakX = firstPeakX + periodPx;
        
        if (secondPeakX < w - 20 && firstPeakX > 20) {
            const arrowY = h / 2 - amp - 35;
            drawDoubleArrow(firstPeakX, arrowY, secondPeakX, arrowY, 'T', '#facc15');
        }

    } else if (state.params.viewType === 'transverse') {
        // --- Transverse wave: particles move perpendicular to propagation ---
        const spacing = 24;
        for (let x = spacing; x < w - spacing; x += spacing) {
            const y = h / 2 + amp * Math.sin(visualK * x - t);
            // Draw equilibrium guide
            ctx.beginPath();
            ctx.moveTo(x, h / 2);
            ctx.lineTo(x, y);
            ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)';
            ctx.lineWidth = 1;
            ctx.stroke();
            // Draw particle
            drawParticle(x, y, '#3b82f6');
        }

        // Propagation direction arrow
        ctx.save();
        ctx.fillStyle = 'rgba(250, 204, 21, 0.7)';
        ctx.font = 'bold 13px Inter';
        ctx.fillText('進行方向 →', w - 130, 30);
        ctx.restore();

    } else if (state.params.viewType === 'longitudinal') {
        // --- Longitudinal wave: particles move parallel to propagation ---
        const spacing = 24;
        const scaleFactor = 0.03; // Scale displacement for longitudinal view
        for (let i = 1; i < w / spacing - 1; i++) {
            const eqX = i * spacing;
            const displacement = amp * scaleFactor * Math.sin(visualK * eqX - t) * spacing;
            // Draw equilibrium guide
            ctx.fillStyle = 'rgba(255,255,255,0.15)';
            ctx.fillRect(eqX - 1, h / 2 - 8, 2, 16);
            // Draw particle
            drawParticle(eqX + displacement, h / 2, '#8b5cf6');
        }

        // Labels for dense and sparse regions
        ctx.save();
        ctx.font = '12px Inter';
        ctx.textAlign = 'center';
        for (let i = 0; i < 3; i++) {
            const phaseTarget = t + 2 * Math.PI * i;
            const denseX = (phaseTarget / visualK) % w;
            const sparseX = ((phaseTarget + Math.PI) / visualK) % w;
            if (denseX > 30 && denseX < w - 30) {
                ctx.fillStyle = 'rgba(239, 68, 68, 0.6)';
                ctx.fillText('密', denseX, h / 2 - 25);
            }
            if (sparseX > 30 && sparseX < w - 30) {
                ctx.fillStyle = 'rgba(96, 165, 250, 0.6)';
                ctx.fillText('疎', sparseX, h / 2 - 25);
            }
        }
        ctx.fillStyle = 'rgba(250, 204, 21, 0.7)';
        ctx.font = 'bold 13px Inter';
        ctx.textAlign = 'left';
        ctx.fillText('進行方向 →', w - 130, 30);
        ctx.restore();
    }
}

function drawReflection(w, h) {
    const amp = state.params.amp * (h / 5);

    const boundaryX = w * 0.85;

    // Fixed physical length of the medium (e.g. a 2m string)
    const physicalLength = 2.0; // meters
    const pixelsPerMeter = boundaryX / physicalLength;

    // λ = v / f — changes with frequency and speed sliders
    const lambda_phys = state.params.speed / state.params.freq;
    const lambda_vis = lambda_phys * pixelsPerMeter;
    const visualK = (2 * Math.PI) / lambda_vis;

    // Visual animation speed (controls oscillation speed on screen, not physical)
    const omega_vis = 2 * Math.PI * 0.4;
    const t = state.params.time * omega_vis;

    // --- Draw boundary wall ---
    ctx.beginPath();
    ctx.moveTo(boundaryX, 0);
    ctx.lineTo(boundaryX, h);
    ctx.strokeStyle = state.params.reflectionBoundary === 'fixed' ? '#ef4444' : '#10b981';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = '14px Inter';
    ctx.fillText(
        state.params.reflectionBoundary === 'fixed' ? '固定端 (Fixed)' : '自由端 (Free)',
        boundaryX - 80, 40
    );

    // --- Wave physics ---
    // u = x - boundaryX  (u <= 0 for the region we draw, boundary at u=0)
    //
    // Incident wave (traveling right, +x direction):
    //   y_inc(u, t) = A sin(k·u − ωt)
    //
    // Fixed end (y=0 at u=0):
    //   y_ref(u, t) = −A sin(−k·u − ωt)   =  A sin(k·u + ωt)
    //   sum at u=0: A sin(−ωt) + A sin(ωt) = 0  ✓
    //   superposition = 2A cos(ωt) sin(k·u)      (standing wave, node at boundary)
    //
    // Free end (antinode at u=0, slope=0 for reflected wave):
    //   y_ref(u, t) =  A sin(−k·u − ωt)   = −A sin(k·u + ωt)
    //   sum at u=0: A sin(−ωt) − A sin(ωt) = −2A sin(ωt)   (antinode) ✓
    //   superposition = −2A sin(ωt) cos(k·u)     (standing wave, antinode at boundary)

    function yIncident(u) {
        return amp * Math.sin(visualK * u - t);
    }

    function yReflected(u) {
        if (state.params.reflectionBoundary === 'fixed') {
            // Inverted reflection
            return amp * Math.sin(visualK * u + t);
        } else {
            // Non-inverted reflection
            return -amp * Math.sin(visualK * u + t);
        }
    }

    const incidentColor = 'rgba(59, 130, 246, 0.8)';
    const reflectedColor = 'rgba(168, 85, 247, 0.8)';
    const superColor = '#facc15';

    if (state.params.reflectionView === 'parts') {
        // --- Draw incident wave (dashed) ---
        ctx.beginPath();
        ctx.setLineDash([6, 4]);
        for (let px = 0; px <= boundaryX; px++) {
            const u = px - boundaryX;
            const y = h / 2 + yIncident(u);
            if (px === 0) ctx.moveTo(px, y);
            else ctx.lineTo(px, y);
        }
        ctx.strokeStyle = incidentColor;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);

        // --- Draw reflected wave (dashed) ---
        ctx.beginPath();
        ctx.setLineDash([6, 4]);
        for (let px = 0; px <= boundaryX; px++) {
            const u = px - boundaryX;
            const y = h / 2 + yReflected(u);
            if (px === 0) ctx.moveTo(px, y);
            else ctx.lineTo(px, y);
        }
        ctx.strokeStyle = reflectedColor;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);

        // --- Draw superposition (solid) ---
        ctx.beginPath();
        for (let px = 0; px <= boundaryX; px++) {
            const u = px - boundaryX;
            const y = h / 2 + yIncident(u) + yReflected(u);
            if (px === 0) ctx.moveTo(px, y);
            else ctx.lineTo(px, y);
        }
        ctx.strokeStyle = superColor;
        ctx.lineWidth = 3;
        ctx.stroke();

        // --- Legend ---
        const legendX = 20;
        const legendY = 30;
        ctx.font = '13px Inter';

        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(legendX, legendY); ctx.lineTo(legendX + 30, legendY);
        ctx.strokeStyle = incidentColor; ctx.lineWidth = 2; ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = incidentColor;
        ctx.fillText('入射波', legendX + 36, legendY + 4);

        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(legendX, legendY + 20); ctx.lineTo(legendX + 30, legendY + 20);
        ctx.strokeStyle = reflectedColor; ctx.lineWidth = 2; ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = reflectedColor;
        ctx.fillText('反射波', legendX + 36, legendY + 24);

        ctx.beginPath(); ctx.moveTo(legendX, legendY + 40); ctx.lineTo(legendX + 30, legendY + 40);
        ctx.strokeStyle = superColor; ctx.lineWidth = 3; ctx.stroke();
        ctx.fillStyle = superColor;
        ctx.fillText('合成波', legendX + 36, legendY + 44);

    } else {
        // --- Superposition only (standing wave) ---

        // Draw the envelope (max amplitude) as a faint guide
        ctx.beginPath();
        for (let px = 0; px <= boundaryX; px++) {
            const u = px - boundaryX;
            let envelope;
            if (state.params.reflectionBoundary === 'fixed') {
                envelope = 2 * amp * Math.abs(Math.sin(visualK * u));
            } else {
                envelope = 2 * amp * Math.abs(Math.cos(visualK * u));
            }
            if (px === 0) ctx.moveTo(px, h / 2 + envelope);
            else ctx.lineTo(px, h / 2 + envelope);
        }
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.2)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.beginPath();
        for (let px = 0; px <= boundaryX; px++) {
            const u = px - boundaryX;
            let envelope;
            if (state.params.reflectionBoundary === 'fixed') {
                envelope = 2 * amp * Math.abs(Math.sin(visualK * u));
            } else {
                envelope = 2 * amp * Math.abs(Math.cos(visualK * u));
            }
            if (px === 0) ctx.moveTo(px, h / 2 - envelope);
            else ctx.lineTo(px, h / 2 - envelope);
        }
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.2)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Draw the actual superposition wave
        ctx.beginPath();
        for (let px = 0; px <= boundaryX; px++) {
            const u = px - boundaryX;
            const y = h / 2 + yIncident(u) + yReflected(u);
            if (px === 0) ctx.moveTo(px, y);
            else ctx.lineTo(px, y);
        }
        ctx.strokeStyle = superColor;
        ctx.lineWidth = 3;
        ctx.stroke();

        // Mark nodes (y=0 always) and antinodes
        for (let px = 0; px <= boundaryX; px += 2) {
            const u = px - boundaryX;
            let envelopeVal;
            if (state.params.reflectionBoundary === 'fixed') {
                envelopeVal = Math.abs(Math.sin(visualK * u));
            } else {
                envelopeVal = Math.abs(Math.cos(visualK * u));
            }
            if (envelopeVal < 0.02) {
                // Node
                ctx.beginPath();
                ctx.arc(px, h / 2, 5, 0, Math.PI * 2);
                ctx.fillStyle = '#ef4444';
                ctx.fill();
                ctx.fillStyle = 'rgba(239, 68, 68, 0.8)';
                ctx.font = '11px Inter';
                ctx.fillText('節', px - 5, h / 2 - 12);
            } else if (envelopeVal > 0.98) {
                // Antinode
                ctx.beginPath();
                ctx.arc(px, h / 2, 5, 0, Math.PI * 2);
                ctx.fillStyle = '#10b981';
                ctx.fill();
                ctx.fillStyle = 'rgba(16, 185, 129, 0.8)';
                ctx.font = '11px Inter';
                ctx.fillText('腹', px - 5, h / 2 + 20);
            }
        }

        // λ/2 spacing annotation between first two nodes
        const nodes = [];
        for (let px = 0; px <= boundaryX; px += 2) {
            const u = px - boundaryX;
            let ev = state.params.reflectionBoundary === 'fixed'
                ? Math.abs(Math.sin(visualK * u))
                : Math.abs(Math.cos(visualK * u));
            if (ev < 0.02 && (nodes.length === 0 || px - nodes[nodes.length - 1] > 20)) {
                nodes.push(px);
            }
        }
        if (nodes.length >= 2) {
            const arrowY = h / 2 + 2 * amp + 30;
            drawDoubleArrow(nodes[0], arrowY, nodes[1], arrowY, 'λ/2', '#facc15');
        }
    }
}

function drawAirColumn(w, h) {
    const pipeW = w * 0.8;
    const pipeH = 100;
    const startX = w * 0.1;
    const startY = h / 2 - pipeH / 2;
    
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 4;
    
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(startX + pipeW, startY);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(startX, startY + pipeH);
    ctx.lineTo(startX + pipeW, startY + pipeH);
    ctx.stroke();
    
    if (state.params.pipeType === 'closed') {
        ctx.beginPath();
        ctx.moveTo(startX + pipeW, startY);
        ctx.lineTo(startX + pipeW, startY + pipeH);
        ctx.stroke();
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(startX + pipeW - 4, startY, 8, pipeH);
    }

    const n = state.params.n;
    const m = state.params.pipeType === 'open' ? n : (2 * n - 1);
    const k_visual = (m * Math.PI) / (state.params.pipeType === 'open' ? pipeW : (2*pipeW));
    
    const freq = calcCurrentFrequency();
    const visScale = 0.005;
    const t = state.params.time * visScale * 2 * Math.PI * freq;
    
    const amp = pipeH * 0.8;
    
    ctx.beginPath();
    for (let x = 0; x <= pipeW; x += 2) {
        let envelope = 0;
        if (state.params.pipeType === 'open') {
            envelope = state.params.pipeDisplay === 'pressure' ? Math.sin(k_visual * x) : Math.cos(k_visual * x);
        } else {
            envelope = state.params.pipeDisplay === 'pressure' ? Math.sin(k_visual * x) : Math.cos(k_visual * x);
        }
        
        const y_offset = amp * envelope * Math.sin(t);
        if (x === 0) ctx.moveTo(startX + x, h/2 + y_offset);
        else ctx.lineTo(startX + x, h/2 + y_offset);
    }
    ctx.strokeStyle = state.params.pipeDisplay === 'pressure' ? '#8b5cf6' : '#3b82f6';
    ctx.lineWidth = 3;
    ctx.stroke();
    
    ctx.beginPath();
    for (let x = 0; x <= pipeW; x += 2) {
        let envelope = 0;
        if (state.params.pipeType === 'open') {
            envelope = state.params.pipeDisplay === 'pressure' ? Math.sin(k_visual * x) : Math.cos(k_visual * x);
        } else {
            envelope = state.params.pipeDisplay === 'pressure' ? Math.sin(k_visual * x) : Math.cos(k_visual * x);
        }
        const y_offset = amp * envelope * Math.sin(t + Math.PI);
        if (x === 0) ctx.moveTo(startX + x, h/2 + y_offset);
        else ctx.lineTo(startX + x, h/2 + y_offset);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // --- Annotations: pipe end labels ---
    ctx.save();
    ctx.font = '12px Inter';
    ctx.textAlign = 'center';
    
    // Left end (always open)
    ctx.fillStyle = 'rgba(16, 185, 129, 0.8)';
    const leftLabel = state.params.pipeDisplay === 'pressure' ? '圧力: 節' : '変位: 腹';
    ctx.fillText('開口端', startX, startY - 20);
    ctx.fillText(leftLabel, startX, startY - 6);
    
    // Right end
    if (state.params.pipeType === 'open') {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.8)';
        const rightLabel = state.params.pipeDisplay === 'pressure' ? '圧力: 節' : '変位: 腹';
        ctx.fillText('開口端', startX + pipeW, startY - 20);
        ctx.fillText(rightLabel, startX + pipeW, startY - 6);
    } else {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.8)';
        const rightLabel = state.params.pipeDisplay === 'pressure' ? '圧力: 腹' : '変位: 節';
        ctx.fillText('閉端', startX + pipeW, startY - 20);
        ctx.fillText(rightLabel, startX + pipeW, startY - 6);
    }
    
    // L annotation
    const arrowY = startY + pipeH + 30;
    drawDoubleArrow(startX, arrowY, startX + pipeW, arrowY, 'L', '#facc15');
    ctx.restore();
}

function drawHelmholtz(w, h) {
    const cavVol = state.params.cavityVol;
    const neckA = state.params.neckArea;
    const neckL = state.params.neckLength;
    
    const centerX = w / 2;
    const centerY = h / 2 + 50;
    
    const rScaled = 150 * Math.pow(cavVol / 0.001, 1/3);
    const wScaled = 40 * Math.sqrt(neckA / 0.0005);
    const lScaled = 80 * (neckL / 0.05);
    
    const neckTopY = centerY - rScaled - lScaled;
    
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 4;
    ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
    
    const angleOffset = Math.asin((wScaled/2) / rScaled);
    ctx.beginPath();
    ctx.arc(centerX, centerY, rScaled, -Math.PI/2 + angleOffset, Math.PI*2 - Math.PI/2 - angleOffset);
    ctx.lineTo(centerX - wScaled/2, neckTopY);
    ctx.lineTo(centerX + wScaled/2, neckTopY);
    ctx.lineTo(centerX + wScaled/2, centerY - rScaled * Math.cos(angleOffset));
    ctx.stroke();
    ctx.fill();
    
    const freq = calcCurrentFrequency();
    const t = state.params.time * 0.005 * 2 * Math.PI * freq;
    const displacement = 20 * Math.sin(t);
    
    ctx.fillStyle = '#3b82f6';
    for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 3; j++) {
            const px = centerX - wScaled/2 + wScaled * (j+1)/4;
            const py = centerY - rScaled - lScaled/2 + displacement + (i * lScaled/6);
            if (py > neckTopY && py < centerY - rScaled/2 + 20) {
                ctx.beginPath();
                ctx.arc(px, py, 3, 0, Math.PI*2);
                ctx.fill();
            }
        }
    }

    // --- Annotations: V, A, L labels ---
    ctx.save();
    ctx.font = 'bold 14px Inter';
    ctx.textAlign = 'center';
    
    // V label (cavity volume)
    ctx.fillStyle = 'rgba(250, 204, 21, 0.9)';
    ctx.fillText('V', centerX, centerY + 10);
    
    // A label (neck cross-section area) with arrow
    const neckMidY = centerY - rScaled - lScaled / 2;
    drawDoubleArrow(centerX - wScaled/2 - 5, neckMidY, centerX + wScaled/2 + 5, neckMidY, 'A', '#10b981');
    
    // L label (neck length)
    drawDoubleArrow(centerX + wScaled/2 + 20, neckTopY, centerX + wScaled/2 + 20, centerY - rScaled * Math.cos(angleOffset), 'L', '#ef4444');
    
    // Frequency display
    ctx.font = 'bold 22px Inter';
    ctx.fillStyle = '#facc15';
    ctx.fillText('f₀ = ' + freq.toFixed(1) + ' Hz', centerX, neckTopY - 25);
    ctx.restore();
}

function drawVocalTract(w, h) {
    const sections = state.params.tractSections;
    const N = 200; // Resolution of simulation
    
    if (!state.vocalTract) {
        state.vocalTract = {
            pPlus: new Float32Array(N),
            pMinus: new Float32Array(N),
            envelope: new Float32Array(N),
            sourcePhase: 0,
            lastTime: state.params.time
        };
    }
    const vt = state.vocalTract;
    
    // Calculate physics steps based on delta time
    const dt = Math.max(0, state.params.time - vt.lastTime);
    vt.lastTime = state.params.time;
    
    // Waveguide physics step
    if (!state.isPaused && dt > 0) {
        // Base frequency of glottal source (F0)
        const freq = state.params.f0;
        const ptsPerSection = Math.floor(N / sections);
        
        // Simulation speed parameter (adjust so waves look visible but fast enough)
        // dt is in seconds, simulated wavespeed c
        const c = state.params.speed; 
        const waveSpeedFactor = 2.0; 
        const simSteps = Math.min(20, Math.floor((dt * c * waveSpeedFactor) / (state.params.tractLength / 100 / N) + 1));
        
        const dtSim = dt / simSteps;
        
        for (let s = 0; s < simSteps; s++) {
            const newPlus = new Float32Array(N);
            const newMinus = new Float32Array(N);
            
            // Glottal source (Excitation) at x = 0
            vt.sourcePhase += 2 * Math.PI * freq * dtSim;
            if (vt.sourcePhase >= 2 * Math.PI) vt.sourcePhase -= 2 * Math.PI;
            
            // Glottal pulse approximation (LF-like):
            const nPhase = vt.sourcePhase / Math.PI; // 0 to 2
            let source = 0;
            if (nPhase < 1.0) {
                source = 0.5 * (1.0 - Math.cos(nPhase * Math.PI)); // Gradual opening
            } else {
                source = Math.max(0, 1.0 - (nPhase - 1.0) * 5.0); // Fast closing
            }
            let inputSignal = (source - 0.5) * state.params.amp; // center around 0
            // Glottis reflects like a mostly closed end (r ~ 0.9)
            newPlus[0] = inputSignal + 0.9 * vt.pMinus[0]; 
            
            // Lips at x = N-1 (Radiation)
            // Lips reflect like an open end (r ~ -0.9, inverts pressure)
            newMinus[N-1] = -0.9 * vt.pPlus[N-1];
            
            // Propagation
            for (let i = 1; i < N; i++) newPlus[i] = vt.pPlus[i-1];
            for (let i = 0; i < N-1; i++) newMinus[i] = vt.pMinus[i+1];
            
            // Junction Scattering
            for (let sec = 0; sec < sections - 1; sec++) {
                const junctionIdx = (sec + 1) * ptsPerSection;
                const A1 = state.params.tractAreas[sec];
                const A2 = state.params.tractAreas[sec + 1];
                const r = (A1 + A2 === 0) ? 0 : (A1 - A2) / (A1 + A2);
                
                const pUp = vt.pPlus[junctionIdx-1];
                const pDown = vt.pMinus[junctionIdx];
                
                // Scattering equations for pressure waves
                newPlus[junctionIdx] = (1 + r) * pUp - r * pDown;
                newMinus[junctionIdx-1] = r * pUp + (1 - r) * pDown;
            }
            
            // Tiny attenuation to keep things stable
            for(let i=0; i<N; i++) {
                vt.pPlus[i] = newPlus[i] * 0.999;
                vt.pMinus[i] = newMinus[i] * 0.999;
                
                // Track envelope
                const pressure = vt.pPlus[i] + vt.pMinus[i];
                vt.envelope[i] = Math.max(vt.envelope[i] * 0.995, Math.abs(pressure));
            }
        }
    }

    // --- Visualization ---
    const startX = w * 0.05;
    const drawW = w * 0.9;
    const centerY = h * 0.25; // Upper quarter/half for tube
    
    // Draw the Tube Shape (Area function)
    const ptsPerSec = drawW / sections;
    
    // Find max area for scaling
    let maxA = 0.1;
    for(let a of state.params.tractAreas) if(a > maxA) maxA = a;
    const maxTubeH = h * 0.3;
    
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 2;
    
    for (let sec = 0; sec < sections; sec++) {
        const A = state.params.tractAreas[sec];
        const tubeH = (A / maxA) * maxTubeH;
        const secX = startX + sec * ptsPerSec;
        
        ctx.beginPath();
        ctx.rect(secX + 1, centerY - tubeH / 2, ptsPerSec - 2, tubeH);
        ctx.fill();
        ctx.stroke();
        
        // Label inside tube
        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.font = '12px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(`A${sec+1}`, secX + ptsPerSec/2, centerY - tubeH/2 - 10);
    }
    
    // Draw the envelope (standing wave)
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
        const px = startX + (i / (N-1)) * drawW;
        const env = vt.envelope[i] * 25;
        if (i === 0) ctx.moveTo(px, centerY - env);
        else ctx.lineTo(px, centerY - env);
    }
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    for (let i = 0; i < N; i++) {
        const px = startX + (i / (N-1)) * drawW;
        const env = vt.envelope[i] * 25;
        if (i === 0) ctx.moveTo(px, centerY + env);
        else ctx.lineTo(px, centerY + env);
    }
    ctx.stroke();

    // Draw the instantaneous pressure wave
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
        const px = startX + (i / (N-1)) * drawW;
        const pressure = vt.pPlus[i] + vt.pMinus[i];
        const py = centerY - pressure * 25; 
        
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = '#facc15'; // Yellow wave
    ctx.lineWidth = 1.5;
    ctx.stroke();
    
    // Annotations: Glottis & Lips
    ctx.save();
    ctx.fillStyle = '#ef4444';
    ctx.font = '14px Inter';
    ctx.textAlign = 'right';
    ctx.fillText('声帯 (Glottis) →', startX - 10, centerY);
    
    ctx.fillStyle = '#10b981';
    ctx.textAlign = 'left';
    ctx.fillText('← 唇 (Lips)', startX + drawW + 10, centerY);
    ctx.restore();

    // --- Spectrum Visualization ---
    const specTop = h * 0.55;
    const specH = h * 0.35;
    const maxFreq = 4000; // Display up to 4 kHz
    
    // Draw axes
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(startX, specTop);
    ctx.lineTo(startX, specTop + specH);
    ctx.lineTo(startX + drawW, specTop + specH);
    ctx.stroke();
    
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '11px Inter';
    ctx.textAlign = 'center';
    for (let f_lbl = 1000; f_lbl <= maxFreq; f_lbl += 1000) {
        const lx = startX + (f_lbl / maxFreq) * drawW;
        ctx.fillText(f_lbl + 'Hz', lx, specTop + specH + 15);
    }
    
    // Draw Formant Envelope (Transfer Function)
    ctx.beginPath();
    const freqSteps = Math.floor(drawW);
    let maxEnvLevel = 0;
    const envCurve = new Float32Array(freqSteps);
    
    // Calculate gain curve
    for (let i = 0; i < freqSteps; i++) {
        const f_sim = (i / freqSteps) * maxFreq;
        const gain = getTractGain(f_sim, state.params.tractAreas, state.params.tractLength, state.params.speed);
        const logGain = Math.log10(gain + 1e-5);
        envCurve[i] = logGain;
        if (logGain > maxEnvLevel) maxEnvLevel = logGain;
    }
    
    let minEnvLevel = maxEnvLevel - 3.0; // Dynamic range ~60dB
    
    ctx.beginPath();
    for (let i = 0; i < freqSteps; i++) {
        const x = startX + i;
        let norm = (envCurve[i] - minEnvLevel) / (maxEnvLevel - minEnvLevel);
        norm = Math.max(0, Math.min(1, norm));
        const y = specTop + specH - norm * specH * 0.9;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(168, 85, 247, 0.8)'; // Purple curve
    ctx.lineWidth = 2;
    ctx.stroke();
    
    ctx.fillStyle = 'rgba(168, 85, 247, 0.8)';
    ctx.textAlign = 'left';
    ctx.fillText('声道伝達特性 (Filter)', startX + 10, specTop + 15);
    
    // Draw Source Harmonics (Line spectrum)
    const f0 = state.params.f0;
    const numHarmonics = Math.floor(maxFreq / f0);
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)'; // Blue
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    for (let k = 1; k <= numHarmonics; k++) {
        const hFreq = k * f0;
        const hx = startX + (hFreq / maxFreq) * drawW;
        
        // Intensity fall-off ~ 1/k
        const sourceLevel = 1.0 - (Math.log10(k) / Math.log10(numHarmonics)) * 0.8; 
        
        const stepIdx = Math.floor((hFreq / maxFreq) * freqSteps);
        const filterVal = (stepIdx >= 0 && stepIdx < freqSteps) ? envCurve[stepIdx] : minEnvLevel;
        let gainNorm = (filterVal - minEnvLevel) / (maxEnvLevel - minEnvLevel);
        gainNorm = Math.max(0, Math.min(1, gainNorm));
        
        const outNorm = gainNorm * sourceLevel;
        const barH = outNorm * specH * 0.9;
        
        ctx.moveTo(hx, specTop + specH);
        ctx.lineTo(hx, specTop + specH - barH);
    }
    ctx.stroke();
    
    ctx.fillStyle = 'rgba(59, 130, 246, 0.8)';
    ctx.textAlign = 'right';
    ctx.fillText('出力スペクトル (Source × Filter)', startX + drawW - 10, specTop + 15);
}

function renderFrame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const w = canvas.width;
    const h = canvas.height;
    
    ctx.beginPath();
    ctx.moveTo(0, h/2);
    ctx.lineTo(w, h/2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (state.mode === 'fundamental') {
        drawFundamental(w, h);
    } else if (state.mode === 'reflection') {
        drawReflection(w, h);
    } else if (state.mode === 'aircolumn') {
        drawAirColumn(w, h);
    } else if (state.mode === 'helmholtz') {
        drawHelmholtz(w, h);
    } else if (state.mode === 'vocaltract') {
        drawVocalTract(w, h);
    }
}

// Boot
window.onload = init;
