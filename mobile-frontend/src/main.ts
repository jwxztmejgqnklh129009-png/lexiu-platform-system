import { createApp } from 'vue'
import {
  ActionSheet, Badge, Button, Cell, CellGroup, ConfigProvider, Dialog, Empty,
  Field, Form, Grid, GridItem, Icon, NavBar, NoticeBar, Popup, Radio, RadioGroup,
  Search, Space, Stepper, Swipe, SwipeItem, Tab, Tabbar, TabbarItem, Tabs, Tag,
  Toast, Checkbox, CheckboxGroup, Collapse, CollapseItem, Image, ImagePreview, Loading, Picker, Switch, Uploader, Divider,
} from 'vant'
import 'vant/lib/index.css'
import './theme.css'
import App from './App.vue'
import { router } from './router'

const app = createApp(App)
for (const component of [
  ActionSheet, Badge, Button, Cell, CellGroup, ConfigProvider, Dialog, Empty,
  Field, Form, Grid, GridItem, Icon, NavBar, NoticeBar, Popup, Radio, RadioGroup,
  Search, Space, Stepper, Swipe, SwipeItem, Tab, Tabbar, TabbarItem, Tabs, Tag, Toast,
  Checkbox, CheckboxGroup, Collapse, CollapseItem, Image, ImagePreview, Loading, Picker, Switch, Uploader, Divider,
]) app.use(component)
app.use(router).mount('#app')
