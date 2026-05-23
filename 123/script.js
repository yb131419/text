// ===================== 全局配置 =====================
const CONFIG = {
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbwgKFHvVz6ZrPN4gkFGP4DMJ6Gwi8DFpLZ5JlMlC-TgL0NnSClqLZvHgtgvlKr1FljcoA/exec",
  LIFF_ID: "2009598216-MmBS77sp"
};

// ===================== 全局變數 =====================
let userId = "";
let userName = "";
const weekDays = ['日','一','二','三','四','五','六'];
const PAGE_SIZE = 6;
const DATE_PAGE_SIZE = 5;
let currentDatePage = 0;
let totalDatePages = 0;
let allDateList = [];
let currentPage=1, totalPage=1, currentServiceList=[], searchKeyword="";
let currentCategory = "面部";
const GLOBAL_DATA = {dateList:[], allServices:[], staffData:{}, staffServices:{} };

// 服務分類
const CATEGORIES = {
  "面部":["液態飛梭","無痛清粉刺","無痛清粉刺+修護敏感項目","無痛清粉刺+靚白水光肌項目","進化黑矽晶重返年輕課程","黑臉娃娃","除疣","除斑","臉部深層保濕課程","臉部皮秒課程","臉部白藻針課程","臉部清粉刺","高階保養"],
  "美甲":["光療美甲","卸甲","光療美甲加卸甲","剪手腳指甲","手部保養","足部保養"],
  "眉眼":["霧眉","霧唇","洗眉"],
  "除毛":["除私密毛","腋下私毛","接睫毛","角蛋白"],
  "頭皮":["外泌體育髮"],
  "乳暈":["無痛粉嫩乳暈術"]
};

// 美容師頭像
function getStaffAvatar(staffName) {
  const avatarMap = {
    "小惠": "https://yb131419.github.io/MoFan/IMG_6059.jpg",
    "Tina": "https://yb131419.github.io/MoFan/IMG_6058.jpg",
    "Nini": "https://picsum.photos/seed/xiaoting/200/200",
    "彥彬": "https://picsum.photos/seed/xiaoting/200/200",
    "auto": "https://picsum.photos/seed/default/200/200"
  };
  return avatarMap[staffName] || "https://picsum.photos/seed/default/200/200";
}

// ===================== 工具函數 =====================
function initBirthdaySelect() {
  const yearSel = document.getElementById('birthYear');
  const monthSel = document.getElementById('birthMonth');
  const daySel = document.getElementById('birthDay');
  
  const now = new Date();
  const currentYear = now.getFullYear();
  for(let y=1940; y<=currentYear; y++){
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y + '年';
    yearSel.appendChild(opt);
  }
  for(let m=1; m<=12; m++){
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m + '月';
    monthSel.appendChild(opt);
  }
  const updateDays = () => {
    daySel.innerHTML = '<option value="">請選擇日</option>';
    const y = yearSel.value;
    const m = monthSel.value;
    if(!y || !m) return;
    const days = new Date(y, m, 0).getDate();
    for(let d=1; d<=days; d++){
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d + '日';
      daySel.appendChild(opt);
    }
  };
  yearSel.addEventListener('change', updateDays);
  monthSel.addEventListener('change', updateDays);
}

function formatPhoneNumber(phone) {
  let numbers = phone.replace(/\D/g, '');
  if(numbers.startsWith('09')){
    if(numbers.length <=4) return numbers;
    if(numbers.length <=7) return numbers.slice(0,4) + '-' + numbers.slice(4);
    return numbers.slice(0,4) + '-' + numbers.slice(4,7) + '-' + numbers.slice(7,10);
  }
  return numbers;
}

// 台北時區
function getTaipeiDateString(date) {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(new Date(date));
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${year}-${month}-${day}`;
}
function getTodayTaipei() {
  return getTaipeiDateString(new Date());
}
function getCurrentTaipeiTime() {
  const now = new Date();
  return new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}

// 時段驗證
function isTimeSlotValid(slotTime, workStart, workEnd, serviceDuration, selectedDate) {
  try {
    if (!slotTime || !workStart || !workEnd || !serviceDuration) return false;
    const nowTaipei = getCurrentTaipeiTime();
    const minAvailableTime = new Date(nowTaipei.getTime() + 2 * 60 * 60 * 1000);
    const slotDateTime = new Date(`${selectedDate}T${slotTime}:00+08:00`);
    const startWork = new Date(`${selectedDate}T${workStart}:00+08:00`);
    const endWork = new Date(`${selectedDate}T${workEnd}:00+08:00`);
    const serviceEndTime = new Date(slotDateTime.getTime() + serviceDuration * 60000);
    const inBusinessHours = slotDateTime >= startWork && serviceEndTime <= endWork;
    const enoughBuffer = slotDateTime >= minAvailableTime;
    return inBusinessHours && enoughBuffer;
  } catch (e) {
    console.error("時段驗證錯誤:", e);
    return false;
  }
}

// 日期過濾
function getValidDatesByService(serviceName) {
  const today = getTodayTaipei();
  let validDates = (GLOBAL_DATA.dateList || []).filter(d => d && d >= today);
  if (!serviceName) return validDates;
  validDates = validDates.filter(date => {
    const staffList = GLOBAL_DATA.staffData[date] || [];
    if (staffList.length === 0) return false;
    return staffList.some(staff => {
      const staffServices = GLOBAL_DATA.staffServices[staff.name] || [];
      return staffServices.some(item => item.name === serviceName);
    });
  });
  return validDates;
}

// ===================== API 請求 =====================
function gasRequest(action, params, callback) {
  const safeParams = params || {};
  let url = CONFIG.SCRIPT_URL + "?action=" + encodeURIComponent(action);
  for(let k in safeParams) {
    const val = safeParams[k] || "";
    url += "&"+encodeURIComponent(k)+"="+encodeURIComponent(val);
  }
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, true);
  xhr.timeout = 15000;
  xhr.ontimeout = () => callback({status:"error",message:"請求超時"});
  xhr.onload = () => {
    try{callback(JSON.parse(xhr.responseText||"{}"))}catch(e){callback({status:"error",message:"系統異常"})}
  };
  xhr.onerror = () => callback({status:"error",message:"網路異常"});
  xhr.send();
}

// ===================== 彈窗/步驟 =====================
function showModal(type,title,desc){
  const m = document.getElementById('modal');
  m.querySelector('.modal-icon').textContent = type==='success'?'✅':'❌';
  m.querySelector('.modal-icon').style.color = type==='success'?'#ff4d88':'#e74c3c';
  m.querySelector('.modal-title').textContent = title;
  m.querySelector('.modal-desc').textContent = desc;
  m.classList.add('active');
}
function closeModal(){document.getElementById('modal').classList.remove('active');}
function goStep(s){
  document.querySelectorAll('.section').forEach(e=>e.classList.remove('active'));
  document.querySelectorAll('.step').forEach(e=>e.classList.remove('active'));
  document.getElementById('step'+s).classList.add('active');
  document.querySelector(`.step[data-step="${s}"]`).classList.add('active');
  window.scrollTo({top:0,behavior:'smooth'});
}

// ===================== 渲染函數 =====================
function renderPagination(){
  const p = document.getElementById('pagination');
  if(totalPage<=1){p.innerHTML='';return;}
  p.innerHTML = `
    <button class="page-btn" ${currentPage===1?'disabled':''} onclick="window.goToPage(1)">首頁</button>
    <button class="page-btn" ${currentPage===1?'disabled':''} onclick="window.goToPage(currentPage-1)">上一頁</button>
    <span class="page-text">${currentPage}/${totalPage}</span>
    <button class="page-btn" ${currentPage===totalPage?'disabled':''} onclick="window.goToPage(currentPage+1)">下一頁</button>
    <button class="page-btn" ${currentPage===totalPage?'disabled':''} onclick="window.goToPage(totalPage)">末頁</button>
  `;
}
window.goToPage = (p)=>{currentPage=p;renderCurrentPage();};

function renderCurrentPage(){
  const g = document.getElementById('serviceGrid');
  g.innerHTML = '';
  if(!currentServiceList.length){g.innerHTML='<div class="loading"><div class="loading-icon"></div>暫無服務</div>';renderPagination();return;}
  const list = currentServiceList.slice((currentPage-1)*PAGE_SIZE,currentPage*PAGE_SIZE);
  list.forEach(item=>{
    if(!item.name)return;
    let desc=item.desc||'';
    if(item.name==="外泌體育髮")desc="（三個月份 無效全額退款)<br>另送整套外泌體組合<br>總額 $35000";
    if(item.name==="無痛粉嫩乳暈術")desc="不需做2~3次<br>做一次就能還回<br>嬰兒時期的『粉嫩色澤』";
    const c=document.createElement('div');c.className='service-card';
    c.innerHTML=`${item.name}<span class="service-duration">${item.duration||0}分</span><span class="service-desc">${desc}</span>`;
    c.onclick=()=>{
      document.querySelectorAll('.service-card').forEach(x=>x.classList.remove('active'));
      c.classList.add('active');
      document.getElementById('selectedService').value=item.name;
      document.getElementById('nextToDate').disabled=false;
      renderFilteredDates();
    };
    g.appendChild(c);
  });
  renderPagination();
}

function renderFilteredDates(){
  allDateList=getValidDatesByService(document.getElementById('selectedService').value.trim());
  totalDatePages=Math.ceil(allDateList.length/DATE_PAGE_SIZE);
  currentDatePage=0;
  const w=document.getElementById('weekSlider');
  if(!allDateList.length){w.innerHTML='<div class="loading"><div class="loading-icon"></div>無可預約日期</div>';document.getElementById('datePagination').innerHTML='';return;}
  renderCurrentDatePage();renderDatePagination();
}

function renderServices(){
  currentPage=1;
  const staff=document.getElementById('selectedStaff').value.trim();
  let filtered=staff&&GLOBAL_DATA.staffServices[staff]
    ?GLOBAL_DATA.staffServices[staff].filter(i=>CATEGORIES[currentCategory].includes(i.name))
    :GLOBAL_DATA.allServices.filter(i=>CATEGORIES[currentCategory].includes(i.name));
  filtered=filtered.filter(s=>s.name&&(!searchKeyword||s.name.includes(searchKeyword)));
  currentServiceList=filtered;totalPage=Math.ceil(filtered.length/PAGE_SIZE);renderCurrentPage();
}

function renderDatePagination(){
  const p=document.getElementById('datePagination');
  if(totalDatePages<=1){p.innerHTML='';return;}
  p.innerHTML=`
    <button class="page-btn" ${currentDatePage===0?'disabled':''} onclick="window.goDatePage(0)">首頁</button>
    <button class="page-btn" ${currentDatePage===0?'disabled':''} onclick="window.goDatePage(currentDatePage-1)">上一頁</button>
    <span class="page-text">${currentDatePage+1}/${totalDatePages}</span>
    <button class="page-btn" ${currentDatePage===totalDatePages-1?'disabled':''} onclick="window.goDatePage(currentDatePage+1)">下一頁</button>
    <button class="page-btn" ${currentDatePage===totalDatePages-1?'disabled':''} onclick="window.goDatePage(totalDatePages-1)">末頁</button>
  `;
}
window.goDatePage=(p)=>{if(p<0||p>=totalDatePages)return;currentDatePage=p;renderCurrentDatePage();renderDatePagination();};

function renderCurrentDatePage(){
  const w=document.getElementById('weekSlider');w.innerHTML='';
  const list=allDateList.slice(currentDatePage*DATE_PAGE_SIZE,(currentDatePage+1)*DATE_PAGE_SIZE);
  list.forEach(d=>{
    const el=document.createElement('div');el.className='week-day';
    const [,m,dy]=d.split('-');const wd=weekDays[new Date(d).getDay()];
    el.innerHTML=`<div class="week-day-date">${m}/${dy}</div><div class="week-day-week">週${wd}</div>`;
    el.onclick=()=>{
      document.querySelectorAll('.week-day').forEach(x=>x.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('selectedDate').value=d;
      renderStaff(d);
    };
    w.appendChild(el);
  });
}

function renderDates(){
  allDateList=getValidDatesByService('');
  totalDatePages=Math.ceil(allDateList.length/DATE_PAGE_SIZE);
  currentDatePage=0;
  const w=document.getElementById('weekSlider');
  if(!allDateList.length){w.innerHTML='<div class="loading"><div class="loading-icon"></div>無可預約日期</div>';document.getElementById('datePagination').innerHTML='';return;}
  renderCurrentDatePage();renderDatePagination();
}

function renderStaff(date){
  const s=document.getElementById('staffList');
  s.innerHTML='<div class="loading"><div class="loading-icon"></div>載入美容師...</div>';
  document.getElementById('selectedStaff').value='';
  document.getElementById('timeGrid').innerHTML='<div class="loading"><div class="loading-icon"></div>請選美容師</div>';
  document.getElementById('nextToInfo').disabled=true;
  if(!date||!GLOBAL_DATA.staffData){s.innerHTML='<div class="loading"><div class="loading-icon"></div>請選日期</div>';return;}
  let list=GLOBAL_DATA.staffData[date]||[];
  const service=document.getElementById('selectedService').value.trim();
  if(service)list=list.filter(st=>GLOBAL_DATA.staffServices[st.name]?.some(i=>i.name===service));
  if(!list.length){s.innerHTML='<div class="loading"><div class="loading-icon"></div>當日無美容師</div>';return;}
  s.innerHTML='';
  const auto=document.createElement('div');auto.className='staff-item';
  auto.innerHTML=`<div class="staff-avatar" style="background-image:url('${getStaffAvatar('auto')}')"></div><div class="staff-info"><div class="staff-name">不指定美容師</div><div class="staff-time">系統自動分配</div></div>`;
  auto.onclick=()=>{
    document.querySelectorAll('.staff-item').forEach(x=>x.classList.remove('active'));
    auto.classList.add('active');
    document.getElementById('selectedStaff').value='auto';
    renderServices();renderSlots();
  };
  s.appendChild(auto);
  list.forEach(st=>{
    const el=document.createElement('div');el.className='staff-item';
    el.innerHTML=`<div class="staff-avatar" style="background-image:url('${getStaffAvatar(st.name)}')"></div><div class="staff-info"><div class="staff-name">${st.name} 老師</div><div class="staff-time">營業時間：${st.start}~${st.end}</div></div>`;
    el.onclick=()=>{
      document.querySelectorAll('.staff-item').forEach(x=>x.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('selectedStaff').value=st.name;
      renderServices();renderSlots();
    };
    s.appendChild(el);
  });
}

function renderSlots(){
  const date=document.getElementById('selectedDate').value.trim();
  const staff=document.getElementById('selectedStaff').value.trim();
  const service=document.getElementById('selectedService').value.trim();
  const g=document.getElementById('timeGrid');
  if(!service){g.innerHTML='<div class="loading"><div class="loading-icon"></div>請選服務</div>';return;}
  if(!date||!staff){g.innerHTML='<div class="loading"><div class="loading-icon"></div>請選日期/美容師</div>';return;}
  const stInfo=GLOBAL_DATA.staffData[date].find(s=>s.name===staff)||{};
  const svInfo=GLOBAL_DATA.allServices.find(s=>s.name===service)||{};
  const dur=svInfo.duration||60;
  g.innerHTML='<div class="loading"><div class="loading-icon"></div>載入時段...</div>';
  document.getElementById('selectedTime').value='';
  document.getElementById('nextToInfo').disabled=true;
  gasRequest("getSlots",{date,staff,service},res=>{
    if(res.status!=="success"){showModal('error','失敗',res.message);g.innerHTML='<div class="loading"><div class="loading-icon"></div>載入失敗</div>';return;}
    let slots=res.slots||[];
    slots=slots.filter(i=>i.time&&isTimeSlotValid(i.time,stInfo.start||"09:00",stInfo.end||"21:00",dur,date));
    g.innerHTML='';
    if(!slots.length){g.innerHTML='<div class="loading"><div class="loading-icon"></div>無可用時段</div>';return;}
    slots.forEach(i=>{
      const b=document.createElement('div');b.className='time-btn';b.textContent=i.time;
      b.onclick=()=>{
        document.querySelectorAll('.time-btn').forEach(x=>x.classList.remove('active'));
        b.classList.add('active');
        document.getElementById('selectedTime').value=i.time;
        document.getElementById('nextToInfo').disabled=false;
      };
      g.appendChild(b);
    });
  });
}

// ===================== 核心功能 =====================
function loadAllData(){
  gasRequest("getAllData",{},res=>{
    document.getElementById('loadingOverlay').style.display='none';
    if(res.status==="success"){
      GLOBAL_DATA.dateList=res.dateList||[];
      GLOBAL_DATA.allServices=res.services||[];
      GLOBAL_DATA.staffData=res.staffData||{};
      GLOBAL_DATA.staffServices=res.staffServices||{};
      renderServices();renderDates();
    }else showModal('error','初始化失敗',res.message);
  });
}

function submit(){
  const btn=document.getElementById('submitBtn');
  if(btn.disabled)return;
  if(!userId){showModal('error','請用LINE登入');return;}
  const s=document.getElementById('selectedService').value,d=document.getElementById('selectedDate').value,
        st=document.getElementById('selectedStaff').value,t=document.getElementById('selectedTime').value,
        name=document.getElementById('name').value,phone=document.getElementById('phone').value;
  if(!s||!d||!st||!t){showModal('error','請完成所有選擇');goStep(1);return;}
  if(!name||!/^09\d{2}-\d{3}-\d{3}$/.test(phone)){showModal('error','請填寫正確姓名/電話');return;}
  
  btn.disabled=true;btn.classList.add('loading');btn.textContent='提交中...';
  const birthday=(document.getElementById('birthYear').value&&document.getElementById('birthMonth').value&&document.getElementById('birthDay').value)
    ?`${document.getElementById('birthYear').value}-${document.getElementById('birthMonth').value.padStart(2,'0')}-${document.getElementById('birthDay').value.padStart(2,'0')}`:'';
  
  gasRequest("submit",{lineId:userId,lineName:userName,date:d,service:s,staff:st,appointTime:t,name,phone,birthday,extraInfo:document.getElementById('extraInfo').value},res=>{
    btn.disabled=false;btn.classList.remove('loading');btn.textContent='確認提交預約';
    if(res.status==="success"){showModal('success','預約成功');setTimeout(()=>window.location.reload(),2000);}
    else showModal('error','預約失敗',res.message);
  });
}

// ===================== LIFF 登入 =====================
async function initLiff(){
  try{
    await new Promise(r=>{let t=0;const c=()=>window.liff?r(true):t++>50?r(false):setTimeout(c,100);c();});
    if(liff.isInClient()){await liff.init({liffId:CONFIG.LIFF_ID});if(!liff.isLoggedIn())liff.login();else{const p=await liff.getProfile();userId=p.userId;userName=p.displayName;}}
  }catch(e){console.log('一般模式')}
  finally{checkAdmin();loadAllData();}
}

// ===================== 管理員功能 =====================
function checkAdmin(){if(!userId)return;gasRequest("checkAdmin",{uid:userId},res=>res.status==="success"&&res.isAdmin&&(document.getElementById("adminFloat").style.display="block",loadAdminStaff()));}
function loadAdminStaff(){gasRequest("getAdminStaff",{},res=>{if(res.status==="success"){const s=document.getElementById("adminStaff");s.innerHTML='<option value="">選擇美容師</option>';res.staffList.forEach(n=>{const o=document.createElement("option");o.value=n;o.textContent=n;s.appendChild(o);})}});}
function loadScheduleList(){const s=document.getElementById("adminStaff").value;if(!s)return;gasRequest("getScheduleList",{staff:s},res=>{const l=document.getElementById("scheduleList");l.innerHTML="";res.status==="success"&&res.list.length?res.list.forEach(i=>{const d=document.createElement("div");d.className="admin-item";d.innerHTML=`${i.date} ${i.start}~${i.end} <span class="admin-del" onclick="window.delSchedule('${s}','${i.date}','${i.start}','${i.end}')">刪除</span>`;l.appendChild(d);}):l.innerHTML="<div class='loading'>無班表</div>";});}
window.delSchedule=(s,d,st,e)=>{if(!confirm("確定刪除？"))return;gasRequest("delSchedule",{staff:s,date:d,start:st,end:e},res=>res.status==="success"?(showModal("success","刪除成功"),loadScheduleList(),loadAllData()):showModal("error","失敗",res.message));};

// ===================== 頁面初始化 =====================
document.addEventListener('DOMContentLoaded',()=>{
  initBirthdaySelect();
  document.getElementById('phone').addEventListener('input',e=>e.target.value=formatPhoneNumber(e.target.value));
  document.getElementById('modalBtn').onclick=closeModal;
  
  const search=document.getElementById('serviceSearch'),clear=document.getElementById('searchClear');
  search.addEventListener('input',e=>{searchKeyword=e.target.value.trim();clear.classList.toggle('show',!!searchKeyword);renderServices();});
  clear.onclick=()=>{search.value='';searchKeyword='';clear.classList.remove('show');renderServices();};
  
  document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));t.classList.add('active');currentCategory=t.dataset.cate;renderServices();});
  document.querySelectorAll('.step').forEach(s=>s.onclick=()=>goStep(s.dataset.step));
  
  document.getElementById('nextToDate').onclick=()=>{renderStaff(document.getElementById('selectedDate').value);goStep(2);};
  document.getElementById('nextToInfo').onclick=()=>goStep(3);
  document.getElementById('submitBtn').onclick=submit;
  
  document.getElementById("adminFloat").onclick=()=>{document.getElementById("adminPanel").style.display="flex";loadScheduleList();};
  document.getElementById("adminClose").onclick=()=>document.getElementById("adminPanel").style.display="none";
  document.querySelectorAll(".admin-tab-btn").forEach(t=>t.onclick=()=>{document.querySelectorAll(".admin-tab-btn").forEach(x=>x.classList.remove("active"));document.querySelectorAll(".admin-section").forEach(x=>x.classList.remove("active"));t.classList.add("active");document.getElementById("admin"+t.dataset.admin.charAt(0).toUpperCase()+t.dataset.admin.slice(1)).classList.add("active");});
  document.getElementById("saveSchedule").onclick=()=>{const s=document.getElementById("adminStaff").value,d=document.getElementById("adminDate").value,st=document.getElementById("adminStart").value,e=document.getElementById("adminEnd").value;if(!s||!d||!st||!e){showModal("error","請填寫完整");return;}gasRequest("saveSchedule",{staff:s,date:d,start:st,end:e},res=>res.status==="success"?(showModal("success","儲存成功"),loadScheduleList(),loadAllData()):showModal("error","失敗",res.message));};
  document.getElementById("queryRecord").onclick=()=>{const d=document.getElementById("recordDate").value;if(!d){showModal("error","請選日期");return;}gasRequest("getRecordByDate",{date:d},res=>{const l=document.getElementById("recordList");l.innerHTML="";res.status==="success"&&res.list.length?res.list.forEach(r=>{const i=document.createElement("div");i.className="admin-item";i.innerHTML=`${r.staff} | ${r.service}<br>${r.time} | ${r.name} ${r.phone}<br>備註：${r.note||'無'}`;l.appendChild(i);}):l.innerHTML="<div class='loading'>當日無預約</div>";});};
  
  initLiff();
});
