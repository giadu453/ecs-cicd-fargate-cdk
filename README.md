# Amazon CI/CD pipeline deploying to ECS Fargate

This project helps you build a complete Amazon ECS cluster and CI/CD pipeline with CodeBuild in **AWS CDK**.

### Procedure to follow:

<b>Step1. Cloud9 and commands to run:</b>

First launch a Cloud9 terminal and prepare it with following commands:

```bash
sudo yum install -y jq
chmod -R 777 deploy.sh 
./deploy.sh 
```
Ensure the Cloud9 is assigned a role of an administrator and from Cloud9 -> AWS Settings -> Credentials -> Disable the Temporary Credentials

Prepare CDK prerequisite:

```bash
sudo yum install -y npm
npm install -g aws-cdk
npm install -g typescript@latest
```

<b>Step2. Configure the GitHub Repository and upload the application:</b>

First Login to your GitHub account. Then search for the repository https://github.com/aws-samples/amazon-ecs-fargate-cdk-cicd and click Fork button to fork this repository into your account.

Then go to the file: amazon-ecs-fargate-cdk-cicd/cdk/lib/ecs_cdk-stack.ts

Click the icon to “Edit this file” and search for the code creating gitHubSource as shown below:

```bash
    const gitHubSource = codebuild.Source.gitHub({
      owner: 'user-name',
      repo: 'amazon-ecs-fargate-cdk-cicd',
      webhook: true, // optional, default: true if `webhookFilteres` were provided, false otherwise
      webhookFilters: [
        codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andBranchIs('main'),
      ], // optional, by default all pushes and Pull Requests will trigger a build
    });
```

```bash
    const sourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: 'GitHub_Source',
      owner: 'user-name',
      repo: 'amazon-ecs-fargate-cdk-cicd',
      branch: 'main',
      oauthToken: cdk.SecretValue.secretsManager("/my/github/token"),
      //oauthToken: cdk.SecretValue.plainText('<plain-text>'),
      output: sourceOutput
    });
```

Replace the user-name with your GitHub userID in 2 places in the file and go to the bottom of the window to populate the Commit title and short description and click Commit Changes

Go to the Clone or download button and copy the https based clone URL. Access your Cloud9 environment and run the copied clone commands after replacing the user-name with your GitHub account username:

```bash
Replace the user-name with your GitHub user-name and then run below commands in the ~/environment directory:
git clone https://github.com/USER-NAME/amazon-ecs-fargate-cdk-cicd.git amazon-ecs-cdk-cicd
```

<b>Step3. :Configure the Secret for your GitHub Token</b>

As a security best practice, never hard-code your GitHub token in the code. Thus we will make use of AWS Secrets Manager service to store the GitHub Token and use it in our code.

```bash
aws configure set region $AWS_REGION
aws secretsmanager create-secret --name /my/github/token --secret-string <GITHUB-TOKEN> 
```
Once the above command is run, check if the secret is stored as expected using below command:

```bash
aws secretsmanager get-secret-value --secret-id /my/github/token --version-stage AWSCURRENT
```
Notice that in the file amazon-ecs-fargate-cdk-cicd/cdk/lib/ecs_cdk-stack.ts, we are using the secret-name /my/github/token, which refers to the stored secret.

Now, run the below command to authorize CodeBuild to access your GitHub account and replace the with your GitHub Token ID:

```bash
Replace the <GITHUB-TOKEN> with your GitHub Token ID:

aws codebuild import-source-credentials --server-type GITHUB --auth-type PERSONAL_ACCESS_TOKEN --token <GITHUB-TOKEN> 
aws codebuild list-source-credentials 
```

Now access the cloned directory:

```bash
cd amazon-ecs-cdk-cicd/cdk
```

<b>Step4. CDK Commands to launch the infrastructure:</b>

```bash
cd cdk
cdk init
npm install
npm run build
cdk ls
```
Ensure that the CDK stack name is: EcsCdkStack

```bash
cdk synth
cdk bootstrap aws://$ACCOUNT_ID/$AWS_REGION
cdk deploy
```

You may be asked to confirm the creation of the roles and authorization before the CloudFormation is executed, for which, you can respond with a “Y”. The infrastructure will take some time to be created, please wait until you see the Output of CloudFormation printed on the terminal.


<b>Step5. Review Infrastructure and flask application:</b>

Collect the DNS Name from the Load Balancer and access it:
<img src="images/alb-dns.png" alt="dashboard" style="border:1px solid black">

<img src="images/web-default.png" alt="dashboard" style="border:1px solid black">

Once the CodePipeline is triggered, CodeBuild will run the set of commands to dockerize the application and push it to the Amazon ECR repository. Before deploying it to the ECS infrastructue, it will ask you for manual approval to move to the next stage. Once approved, it will deploy the application into ECS platform, by creating the task definition, service and instantiating the tasks to the desired count. In our case, the default desired count is 1 and thus an instance of flask application will be accessible from Load Balancer as shown above.
The deployment on the ECS initially will take around 5 minutes to ensure the older application task is gracefully drained out and the new task is launched. You would see the ECS service reach a Steady State (shown below), after which the application is accessible. Also notice that the Desired count number is reached.

<img src="images/ecs-steadystate.png" alt="dashboard" style="border:1px solid black">

On accessing the application via ALB, the content will be updated to be below image:

<img src="images/ecs-deployed.png" alt="dashboard" style="border:1px solid black">

Once code commited and CodePipeline is kicked off, it will deploy the application to the fargate. The successful run of the CI/CD pipeline would look like below:

<img src="images/stage12-green.png" alt="dashboard" style="border:1px solid black">
<img src="images/stage34-green.png" alt="dashboard" style="border:1px solid black">



